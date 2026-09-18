//! Optional observation only: never serialized as guest state or used to drive time.
//! Records are 10 little-endian u32 words: kind, ticks(lo/hi), PC, address,
//! value, width, auxiliary, estimated CPU cycles(lo/hi). Cycles are uncalibrated.
use std::collections::VecDeque;

pub const RECORD_WORDS: usize = 10;
pub const MAX_RECORDS: usize = 32_768;
pub const MMIO: u32 = 1;
pub const TRANSITIONS: u32 = 2;
pub const STEPS: u32 = 4;

#[derive(Default)]
pub struct Trace {
    flags: u32,
    capacity: usize,
    records: VecDeque<[u32; RECORD_WORDS]>,
    pub dropped: u64,
    output: Vec<u32>,
}

impl Trace {
    pub fn configure(&mut self, flags: u32, capacity: usize) -> bool {
        if flags & !7 != 0 || capacity > MAX_RECORDS || (flags != 0 && capacity == 0) {
            return false;
        }
        *self = Self {
            flags,
            capacity,
            records: VecDeque::with_capacity(capacity),
            ..Self::default()
        };
        true
    }
    pub fn enabled(&self, flag: u32) -> bool {
        self.flags & flag != 0
    }
    pub fn push(&mut self, record: [u32; RECORD_WORDS]) {
        if self.capacity == 0 || self.flags == 0 {
            return;
        }
        if self.records.len() == self.capacity {
            self.records.pop_front();
            self.dropped = self.dropped.saturating_add(1);
        }
        self.records.push_back(record);
    }
    /// Export a stable copy. Does not consume or clear observation history.
    pub fn export(&mut self) -> usize {
        self.output.clear();
        for record in &self.records {
            self.output.extend_from_slice(record);
        }
        self.output.len() * 4
    }
    pub fn ptr(&self) -> *const u32 {
        self.output.as_ptr()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounded_and_transactional() {
        let mut t = Trace::default();
        assert!(t.configure(MMIO, 2));
        for i in 0..4 {
            t.push([i; RECORD_WORDS]);
        }
        assert_eq!(t.dropped, 2);
        assert!(!t.configure(8, 2));
        assert!(!t.configure(STEPS, MAX_RECORDS + 1));
        assert!(!t.configure(STEPS, 0));
        assert!(t.enabled(MMIO));
        assert_eq!(t.export(), 80);
        assert_eq!(t.output[0], 2);
        assert_eq!(t.output[10], 3);
        assert!(t.configure(0, 0));
        t.push([1; RECORD_WORDS]);
        assert_eq!(t.export(), 0);
    }
}
