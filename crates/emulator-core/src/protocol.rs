//! Pebble wire framing: big-endian payload length, big-endian endpoint, payload.
//! No radio/controller emulation or automatic watch response is implied by this codec.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Packet {
    pub endpoint: u16,
    pub payload: Vec<u8>,
}

impl Packet {
    pub fn encode(&self) -> Result<Vec<u8>, String> {
        let length =
            u16::try_from(self.payload.len()).map_err(|_| "Payload exceeds 65535 bytes")?;
        let mut bytes = Vec::with_capacity(self.payload.len() + 4);
        bytes.extend_from_slice(&length.to_be_bytes());
        bytes.extend_from_slice(&self.endpoint.to_be_bytes());
        bytes.extend_from_slice(&self.payload);
        Ok(bytes)
    }
}

#[derive(Default)]
pub struct Decoder {
    buffer: Vec<u8>,
}
impl Decoder {
    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<Packet>, String> {
        let mut packets = Vec::new();
        let mut remaining = bytes;
        while !remaining.is_empty() {
            let target = if self.buffer.len() < 4 {
                4
            } else {
                4 + u16::from_be_bytes([self.buffer[0], self.buffer[1]]) as usize
            };
            let count = (target - self.buffer.len()).min(remaining.len());
            self.buffer.extend_from_slice(&remaining[..count]);
            remaining = &remaining[count..];
            if self.buffer.len() >= 4 {
                let length = u16::from_be_bytes([self.buffer[0], self.buffer[1]]) as usize;
                if self.buffer.len() == length + 4 {
                    packets.push(Packet {
                        endpoint: u16::from_be_bytes([self.buffer[2], self.buffer[3]]),
                        payload: self.buffer[4..].to_vec(),
                    });
                    self.buffer.clear();
                }
            }
        }
        Ok(packets)
    }
    pub fn finish(&self) -> Result<(), String> {
        if self.buffer.is_empty() {
            Ok(())
        } else {
            Err("Truncated Pebble frame at end of stream".into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ping_matches_libpebble2_golden_vector() {
        let p = Packet {
            endpoint: 2001,
            payload: vec![0, 0x12, 0x34, 0x56, 0x78, 0],
        };
        assert_eq!(
            p.encode().unwrap(),
            vec![0, 6, 7, 0xd1, 0, 0x12, 0x34, 0x56, 0x78, 0]
        );
    }
    #[test]
    fn every_fragment_boundary_and_concatenation() {
        let bytes = [0, 1, 0, 11, 0, 0, 2, 0, 48, 0xff, 0x2a];
        for cut in 0..=bytes.len() {
            let mut d = Decoder::default();
            let mut p = d.push(&bytes[..cut]).unwrap();
            p.extend(d.push(&bytes[cut..]).unwrap());
            assert_eq!(
                p,
                vec![
                    Packet {
                        endpoint: 11,
                        payload: vec![0]
                    },
                    Packet {
                        endpoint: 48,
                        payload: vec![255, 42]
                    }
                ]
            );
        }
    }
    #[test]
    fn empty_payload_is_a_valid_frame() {
        assert_eq!(
            Decoder::default().push(&[0, 0, 0, 1]).unwrap(),
            vec![Packet {
                endpoint: 1,
                payload: vec![]
            }]
        );
    }
    #[test]
    fn rejects_oversized_payload() {
        assert!(
            Packet {
                endpoint: 1,
                payload: vec![0; 65536]
            }
            .encode()
            .is_err()
        );
    }
    #[test]
    fn truncated_eof_is_not_silently_accepted() {
        let mut d = Decoder::default();
        assert!(d.finish().is_ok());
        d.push(&[0, 2, 0, 48, 255]).unwrap();
        assert!(d.finish().is_err());
        assert_eq!(d.push(&[42]).unwrap().len(), 1);
        assert!(d.finish().is_ok());
    }
    #[test]
    fn large_complete_stream_is_independent_of_chunking() {
        let packet = Packet {
            endpoint: 999,
            payload: vec![42; 65535],
        }
        .encode()
        .unwrap();
        let bytes = packet.repeat(17);
        let mut d = Decoder::default();
        assert_eq!(d.push(&bytes).unwrap().len(), 17);
        assert!(d.finish().is_ok());
    }
}
