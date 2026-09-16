//! Original ARMv8-M instruction vectors assembled with LLVM; no firmware needed.
use emulator_qemu::{board_step, boot};
#[derive(Clone, Copy)]
struct Form {
    name: &'static str,
    load: [u16; 2],
    store: [u16; 2],
    width: usize,
}
const FORMS: [Form; 6] = [
    Form {
        name: "word",
        load: [0xe850, 0x1f00],
        store: [0xe840, 0x2300],
        width: 4,
    },
    Form {
        name: "byte",
        load: [0xe8d0, 0x1f4f],
        store: [0xe8c0, 0x2f43],
        width: 1,
    },
    Form {
        name: "half",
        load: [0xe8d0, 0x1f5f],
        store: [0xe8c0, 0x2f53],
        width: 2,
    },
    Form {
        name: "acquire-word",
        load: [0xe8d0, 0x1fef],
        store: [0xe8c0, 0x2fe3],
        width: 4,
    },
    Form {
        name: "acquire-byte",
        load: [0xe8d0, 0x1fcf],
        store: [0xe8c0, 0x2fc3],
        width: 1,
    },
    Form {
        name: "acquire-half",
        load: [0xe8d0, 0x1fdf],
        store: [0xe8c0, 0x2fd3],
        width: 2,
    },
];
fn image(main: &[u16], handler: &[u16]) -> Vec<u8> {
    let mut out = vec![0; 512];
    out[..4].copy_from_slice(&0x20001000u32.to_le_bytes());
    out[4..8].copy_from_slice(&0x101u32.to_le_bytes());
    out[60..64].copy_from_slice(&0x181u32.to_le_bytes());
    for (offset, ops) in [(0x100, main), (0x180, handler)] {
        for (i, op) in ops.iter().enumerate() {
            out[offset + i * 2..offset + i * 2 + 2].copy_from_slice(&op.to_le_bytes());
        }
    }
    out
}
fn address(form: Form) -> u32 {
    0x20000380
        + match form.width {
            1 => 1,
            2 => 2,
            _ => 0,
        }
}
fn expected(form: Form) -> u32 {
    match form.width {
        1 => 0x11,
        2 => 0x3322,
        _ => 0x33221100,
    }
}
#[test]
fn exclusive_pairs_succeed_and_clear_monitor() {
    for f in FORMS {
        let ops = [
            f.load.as_slice(),
            f.store.as_slice(),
            f.store.as_slice(),
            &[0xe7fe],
        ]
        .concat();
        let (mut c, mut b) = boot(image(&ops, &[0x4770]));
        b.ram[0x380..0x384].copy_from_slice(&[0, 0x11, 0x22, 0x33]);
        c.regs.r[0] = address(f);
        c.regs.r[2] = 0xaabbccdd;
        board_step(&mut c, &mut b);
        assert_eq!(c.regs.r[1], expected(f), "{} load", f.name);
        board_step(&mut c, &mut b);
        assert_eq!(c.regs.r[3], 0, "{} store", f.name);
        let offset = (address(f) - 0x20000000) as usize;
        assert_eq!(
            &b.ram[offset..offset + f.width],
            &0xaabbccddu32.to_le_bytes()[..f.width],
            "{} value",
            f.name
        );
        let original = b.ram[0x380..0x384].to_vec();
        c.regs.r[2] = 0x12345678;
        board_step(&mut c, &mut b);
        assert_eq!(c.regs.r[3], 1, "{} repeated store", f.name);
        assert_eq!(&b.ram[0x380..0x384], original);
    }
}
#[test]
fn stores_without_monitor_fail() {
    for f in FORMS {
        let (mut c, mut b) = boot(image(&f.store, &[0x4770]));
        c.regs.r[0] = address(f);
        c.regs.r[2] = 0x12345678;
        board_step(&mut c, &mut b);
        assert_eq!(c.regs.r[3], 1, "{}", f.name);
        assert_eq!(&b.ram[0x380..0x384], &[0; 4]);
    }
}
#[test]
fn clrex_clears_all_exclusive_forms() {
    for f in FORMS {
        let ops = [f.load.as_slice(), &[0xf3bf, 0x8f2f], f.store.as_slice()].concat();
        let (mut c, mut b) = boot(image(&ops, &[0x4770]));
        c.regs.r[0] = address(f);
        c.regs.r[2] = 99;
        for _ in 0..3 {
            board_step(&mut c, &mut b);
        }
        assert_eq!(c.regs.r[3], 1, "{}", f.name);
        assert_eq!(&b.ram[0x380..0x384], &[0; 4]);
    }
}
#[test]
fn exception_entry_clears_exclusive_reservation() {
    for f in FORMS {
        let ops = [f.load.as_slice(), f.store.as_slice(), &[0xe7fe]].concat();
        let (mut c, mut b) = boot(image(&ops, &[0x4770]));
        c.regs.r[0] = address(f);
        c.regs.r[2] = 99;
        board_step(&mut c, &mut b);
        c.ppb.pend_systick();
        for _ in 0..3 {
            board_step(&mut c, &mut b);
        }
        assert_eq!(c.regs.r[3], 1, "{}", f.name);
        assert_eq!(&b.ram[0x380..0x384], &[0; 4]);
    }
}
#[test]
fn exception_return_does_not_leak_handler_reservation() {
    for f in FORMS {
        let ops = [f.store.as_slice(), &[0xe7fe]].concat();
        let handler = [f.load.as_slice(), &[0x4770]].concat();
        let (mut c, mut b) = boot(image(&ops, &handler));
        c.regs.r[0] = address(f);
        c.regs.r[2] = 99;
        c.ppb.pend_systick();
        for _ in 0..4 {
            board_step(&mut c, &mut b);
        }
        assert_eq!(c.regs.r[3], 1, "{}", f.name);
        assert_eq!(&b.ram[0x380..0x384], &[0; 4]);
    }
}
#[test]
fn exception_psp_context_switch_does_not_transfer_reservation() {
    for f in FORMS {
        let ops = [f.load.as_slice(), f.store.as_slice(), &[0xe7fe]].concat();
        // Handler takes its own reservation then selects another task's stack.
        let handler = [f.load.as_slice(), &[0xf384, 0x8809, 0x4770]].concat();
        let (mut c, mut b) = boot(image(&ops, &handler));
        c.regs.control = 2;
        c.regs.psp = 0x20002000;
        c.regs.r[13] = 0x20002000;
        c.regs.r[0] = address(f);
        c.regs.r[2] = 99;
        c.regs.r[4] = 0x20002fe0;
        let next = [address(f), 0, 77, 0, 0, 0xffffffff, 0x104, 0x01000000];
        for (i, v) in next.iter().enumerate() {
            b.ram[0x2fe0 + i * 4..0x2fe4 + i * 4].copy_from_slice(&v.to_le_bytes());
        }
        board_step(&mut c, &mut b);
        c.ppb.pend_systick();
        for _ in 0..5 {
            board_step(&mut c, &mut b);
        }
        assert_eq!(c.regs.r[3], 1, "{} leaked monitor", f.name);
        assert_eq!(c.regs.psp, 0x20003000);
        assert_eq!(c.regs.r[13], 0x20003000);
        assert_eq!(c.regs.msp, 0x20001000);
        assert_eq!(c.regs.ipsr(), 0);
        assert_eq!(&b.ram[0x380..0x384], &[0; 4]);
    }
}
#[test]
fn acquiring_a_different_word_replaces_monitor() {
    for f in FORMS {
        let ops = [f.load.as_slice(), f.load.as_slice(), f.store.as_slice()].concat();
        let (mut c, mut b) = boot(image(&ops, &[0x4770]));
        c.regs.r[0] = address(f);
        c.regs.r[2] = 99;
        board_step(&mut c, &mut b);
        c.regs.r[0] += 4;
        board_step(&mut c, &mut b);
        c.regs.r[0] -= 4;
        board_step(&mut c, &mut b);
        assert_eq!(c.regs.r[3], 1, "{}", f.name);
    }
}
#[test]
fn nonexclusive_acquire_release_do_not_require_monitor() {
    for (width, load, store) in [
        (4, [0xe8d0, 0x1faf], [0xe8c0, 0x2faf]),
        (1, [0xe8d0, 0x1f8f], [0xe8c0, 0x2f8f]),
        (2, [0xe8d0, 0x1f9f], [0xe8c0, 0x2f9f]),
    ] {
        let ops = [store.as_slice(), load.as_slice()].concat();
        let (mut c, mut b) = boot(image(&ops, &[0x4770]));
        c.regs.r[0] = 0x20000380;
        c.regs.r[2] = 0xaabbccdd;
        c.regs.r[3] = 95;
        board_step(&mut c, &mut b);
        board_step(&mut c, &mut b);
        let mask = if width == 4 {
            u32::MAX
        } else {
            (1u32 << (width * 8)) - 1
        };
        assert_eq!(c.regs.r[1], 0xaabbccdd & mask);
        assert_eq!(c.regs.r[3], 95);
    }
}
