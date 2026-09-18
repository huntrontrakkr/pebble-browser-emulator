//! Functional split caches; no cycle or silicon replacement-policy claim.
//! SiFli HCPU geometry: 32-byte lines, 32 KiB/2-way I and 16 KiB/4-way D.
//! Replacement is deterministic round-robin. Unknown backing bytes remain unknown.
use crate::{AccessFault, Operation, SifliAddressSpace, system::Policy};

#[derive(Clone, Default)]
struct Line {
    tag: Option<u32>,
    bytes: [u8; 32],
    known: u32,
    dirty: u32,
}
pub struct Cache {
    lines: Vec<Line>,
    next: Vec<usize>,
    sets: usize,
    ways: usize,
}

impl Cache {
    pub fn instruction() -> Self {
        Self::new(512, 2)
    }
    pub fn data() -> Self {
        Self::new(128, 4)
    }
    fn new(sets: usize, ways: usize) -> Self {
        Self {
            lines: vec![Line::default(); sets * ways],
            next: vec![0; sets],
            sets,
            ways,
        }
    }
    fn find(&self, a: u32) -> Option<usize> {
        let set = (a as usize / 32) % self.sets;
        (set * self.ways..(set + 1) * self.ways).find(|&i| self.lines[i].tag == Some(a & !31))
    }
    /// Inspect a cached byte without filling, evicting, cleaning or changing state.
    /// None means cache miss; an unknown cached byte must stay unknown.
    pub fn peek_byte(&self, a: u32) -> Option<Result<u8, crate::FaultKind>> {
        self.find(a).map(|i| {
            let line = &self.lines[i];
            if line.known & (1 << (a & 31)) == 0 {
                Err(crate::FaultKind::UninitializedHcpuRam)
            } else {
                Ok(line.bytes[(a & 31) as usize])
            }
        })
    }
    fn clean(
        &mut self,
        i: usize,
        memory: &mut SifliAddressSpace,
        pc: u32,
    ) -> Result<(), AccessFault> {
        let line = &mut self.lines[i];
        if let Some(a) = line.tag {
            for n in 0..32 {
                if line.dirty & (1 << n) != 0 {
                    memory.write(pc, a + n, 1, line.bytes[n as usize] as u32)?;
                }
            }
        }
        line.dirty = 0;
        Ok(())
    }
    fn allocate(
        &mut self,
        a: u32,
        memory: &mut SifliAddressSpace,
        pc: u32,
    ) -> Result<usize, AccessFault> {
        if let Some(i) = self.find(a) {
            return Ok(i);
        }
        let set = (a as usize / 32) % self.sets;
        let i = (set * self.ways..(set + 1) * self.ways)
            .find(|&i| self.lines[i].tag.is_none())
            .unwrap_or(set * self.ways + self.next[set]);
        self.next[set] = (i % self.ways + 1) % self.ways;
        self.clean(i, memory, pc)?;
        let mut line = Line {
            tag: Some(a & !31),
            ..Line::default()
        };
        for n in 0..32 {
            if let Ok(b) = memory.read(pc, (a & !31) + n, 1, Operation::Read) {
                line.bytes[n as usize] = b as u8;
                line.known |= 1 << n;
            }
        }
        self.lines[i] = line;
        Ok(i)
    }
    pub fn read(
        &mut self,
        memory: &mut SifliAddressSpace,
        pc: u32,
        a: u32,
        width: u8,
        op: Operation,
    ) -> Result<u32, AccessFault> {
        // Region validation precedes speculative line fill; only selected
        // bytes must be initialized. Adjacent unknown bytes stay unknown.
        memory.region(pc, a, width, op)?;
        let mut value = 0;
        for n in 0..width {
            let address = a + n as u32;
            let i = self.allocate(address, memory, pc)?;
            let offset = (address & 31) as usize;
            if self.lines[i].known & (1 << offset) == 0 {
                // Obtain the precise missing-state diagnostic without treating
                // a later external write as automatically coherent.
                let mut fault = memory
                    .read(pc, address, 1, op)
                    .err()
                    .unwrap_or(AccessFault {
                        revision: memory.revision(),
                        pc,
                        address,
                        width: 1,
                        operation: op,
                        kind: crate::FaultKind::UninitializedHcpuRam,
                    });
                fault.address = a;
                fault.width = width;
                return Err(fault);
            }
            value |= (self.lines[i].bytes[offset] as u32) << (8 * n);
        }
        Ok(value)
    }
    pub fn write(
        &mut self,
        memory: &mut SifliAddressSpace,
        pc: u32,
        a: u32,
        width: u8,
        value: u32,
        policy: Policy,
    ) -> Result<(), AccessFault> {
        memory.region(pc, a, width, Operation::Write)?;
        if policy == Policy::WriteThrough {
            memory.write(pc, a, width, value)?;
        }
        for n in 0..width {
            let address = a + n as u32;
            let index = if policy == Policy::WriteBack {
                Some(self.allocate(address, memory, pc)?)
            } else {
                self.find(address)
            };
            if let Some(i) = index {
                let offset = (address & 31) as usize;
                self.lines[i].bytes[offset] = (value >> (8 * n)) as u8;
                self.lines[i].known |= 1 << offset;
                if policy == Policy::WriteBack {
                    self.lines[i].dirty |= 1 << offset;
                }
            }
        }
        Ok(())
    }
    pub fn invalidate_all(&mut self) {
        self.lines.fill(Line::default());
    }
    pub fn invalidate_address(&mut self, address: u32) {
        if let Some(i) = self.find(address) {
            self.lines[i] = Line::default();
        }
    }
    pub fn maintain(
        &mut self,
        memory: &mut SifliAddressSpace,
        pc: u32,
        value: u32,
        by_set: bool,
        clean: bool,
        invalidate: bool,
    ) -> Result<(), AccessFault> {
        let index = if by_set {
            // Four data ways in [31:30], 128 sets in [11:5].
            Some((((value >> 5) & 127) as usize) * self.ways + ((value >> 30) as usize))
        } else {
            self.find(value)
        };
        if let Some(i) = index {
            if clean {
                self.clean(i, memory, pc)?;
            }
            if invalidate {
                self.lines[i] = Line::default();
            }
        }
        Ok(())
    }
}
