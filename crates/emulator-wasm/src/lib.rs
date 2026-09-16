//! Versioned browser ABI; execution is isolated in a Worker.
use pebble_emulator_core::{Machine, protocol::Packet};
use std::cell::RefCell;
thread_local! {
    static MACHINE: RefCell<Machine> = RefCell::new(Machine::default());
    static INPUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static OUTPUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}
fn output(bytes: Vec<u8>) {
    OUTPUT.with(|o| *o.borrow_mut() = bytes);
}
fn result(r: Result<(), String>) -> u32 {
    match r {
        Ok(()) => {
            output(Vec::new());
            1
        }
        Err(e) => {
            output(e.into_bytes());
            0
        }
    }
}
#[unsafe(no_mangle)]
pub extern "C" fn abi_version() -> u32 {
    1
}
#[unsafe(no_mangle)]
pub extern "C" fn load_diagnostic() {
    MACHINE.with(|m| m.borrow_mut().load_diagnostic());
}
#[unsafe(no_mangle)]
pub extern "C" fn reset() -> u32 {
    result(MACHINE.with(|m| m.borrow_mut().reset()))
}
#[unsafe(no_mangle)]
pub extern "C" fn run(budget: u32) -> u32 {
    MACHINE.with(|m| m.borrow_mut().run(budget))
}
#[unsafe(no_mangle)]
pub extern "C" fn register(index: u32) -> u32 {
    MACHINE.with(|m| {
        m.borrow()
            .registers
            .get(index as usize)
            .copied()
            .unwrap_or(0)
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn flags() -> u32 {
    MACHINE.with(|m| m.borrow().xpsr)
}
#[unsafe(no_mangle)]
pub extern "C" fn instructions() -> f64 {
    MACHINE.with(|m| m.borrow().instructions as f64)
}
#[unsafe(no_mangle)]
pub extern "C" fn halted() -> u32 {
    MACHINE.with(|m| u32::from(m.borrow().halted))
}
#[unsafe(no_mangle)]
pub extern "C" fn fault() {
    output(MACHINE.with(|m| m.borrow().fault.clone().unwrap_or_default().into_bytes()));
}
#[unsafe(no_mangle)]
pub extern "C" fn framebuffer_ptr() -> *const u8 {
    MACHINE.with(|m| m.borrow().framebuffer.as_ptr())
}
#[unsafe(no_mangle)]
pub extern "C" fn set_inputs(buttons: u32, battery: u32) {
    MACHINE.with(|m| {
        let mut m = m.borrow_mut();
        m.buttons = buttons & 15;
        m.battery = battery.min(100)
    });
}
#[unsafe(no_mangle)]
pub extern "C" fn buttons() -> u32 {
    MACHINE.with(|m| m.borrow().buttons)
}
#[unsafe(no_mangle)]
pub extern "C" fn battery() -> u32 {
    MACHINE.with(|m| m.borrow().battery)
}
#[unsafe(no_mangle)]
pub extern "C" fn input_reserve(length: u32) -> *mut u8 {
    if length > 24 * 1024 * 1024 {
        return std::ptr::null_mut();
    }
    INPUT.with(|i| {
        let mut i = i.borrow_mut();
        i.resize(length as usize, 0);
        i.as_mut_ptr()
    })
}
#[unsafe(no_mangle)]
pub extern "C" fn load_image() -> u32 {
    result(INPUT.with(|i| MACHINE.with(|m| m.borrow_mut().load(&i.borrow()))))
}
#[unsafe(no_mangle)]
pub extern "C" fn snapshot() {
    output(MACHINE.with(|m| m.borrow().snapshot().into_bytes()));
}
#[unsafe(no_mangle)]
pub extern "C" fn restore() -> u32 {
    result(INPUT.with(|i| {
        let i = i.borrow();
        let s = std::str::from_utf8(&i).map_err(|e| e.to_string())?;
        MACHINE.with(|m| m.borrow_mut().restore(s))
    }))
}
#[unsafe(no_mangle)]
pub extern "C" fn encode_ping(cookie: u32) {
    let mut payload = vec![0];
    payload.extend_from_slice(&cookie.to_be_bytes());
    payload.push(0);
    output(
        Packet {
            endpoint: 2001,
            payload,
        }
        .encode()
        .unwrap(),
    );
}
#[unsafe(no_mangle)]
pub extern "C" fn output_ptr() -> *const u8 {
    OUTPUT.with(|o| o.borrow().as_ptr())
}
#[unsafe(no_mangle)]
pub extern "C" fn output_len() -> u32 {
    OUTPUT.with(|o| o.borrow().len() as u32)
}
