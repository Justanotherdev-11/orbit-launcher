//! Just enough NBT to read and write `servers.dat` and peek at `level.dat`.
use anyhow::{bail, Result};
use std::io::Read;

#[derive(Debug, Clone)]
pub enum Tag {
    End,
    Byte(i8),
    Short(i16),
    Int(i32),
    Long(i64),
    Float(f32),
    Double(f64),
    ByteArray(Vec<i8>),
    String(String),
    List(u8, Vec<Tag>),
    Compound(Vec<(String, Tag)>),
    IntArray(Vec<i32>),
    LongArray(Vec<i64>),
}

impl Tag {
    pub fn id(&self) -> u8 {
        match self {
            Tag::End => 0,
            Tag::Byte(_) => 1,
            Tag::Short(_) => 2,
            Tag::Int(_) => 3,
            Tag::Long(_) => 4,
            Tag::Float(_) => 5,
            Tag::Double(_) => 6,
            Tag::ByteArray(_) => 7,
            Tag::String(_) => 8,
            Tag::List(..) => 9,
            Tag::Compound(_) => 10,
            Tag::IntArray(_) => 11,
            Tag::LongArray(_) => 12,
        }
    }
    pub fn get(&self, key: &str) -> Option<&Tag> {
        match self {
            Tag::Compound(v) => v.iter().find(|(k, _)| k == key).map(|(_, t)| t),
            _ => None,
        }
    }
    pub fn str(&self) -> Option<&str> {
        match self {
            Tag::String(s) => Some(s),
            _ => None,
        }
    }
    pub fn int(&self) -> Option<i64> {
        match self {
            Tag::Byte(v) => Some(*v as i64),
            Tag::Short(v) => Some(*v as i64),
            Tag::Int(v) => Some(*v as i64),
            Tag::Long(v) => Some(*v),
            _ => None,
        }
    }
}

struct Reader<'a> {
    d: &'a [u8],
    p: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8]> {
        if self.p + n > self.d.len() {
            bail!("Truncated NBT");
        }
        let s = &self.d[self.p..self.p + n];
        self.p += n;
        Ok(s)
    }
    fn u8(&mut self) -> Result<u8> {
        Ok(self.take(1)?[0])
    }
    fn i16(&mut self) -> Result<i16> {
        Ok(i16::from_be_bytes(self.take(2)?.try_into()?))
    }
    fn i32(&mut self) -> Result<i32> {
        Ok(i32::from_be_bytes(self.take(4)?.try_into()?))
    }
    fn i64(&mut self) -> Result<i64> {
        Ok(i64::from_be_bytes(self.take(8)?.try_into()?))
    }
    fn len(&mut self) -> Result<usize> {
        Ok(self.i32()?.max(0) as usize)
    }
    fn string(&mut self) -> Result<String> {
        let n = self.i16()? as u16 as usize;
        Ok(mutf8_decode(self.take(n)?))
    }
    fn payload(&mut self, id: u8, depth: u32) -> Result<Tag> {
        if depth > 64 {
            bail!("NBT too deep");
        }
        Ok(match id {
            0 => Tag::End,
            1 => Tag::Byte(self.u8()? as i8),
            2 => Tag::Short(self.i16()?),
            3 => Tag::Int(self.i32()?),
            4 => Tag::Long(self.i64()?),
            5 => Tag::Float(f32::from_bits(self.i32()? as u32)),
            6 => Tag::Double(f64::from_bits(self.i64()? as u64)),
            7 => {
                let n = self.len()?;
                Tag::ByteArray(self.take(n)?.iter().map(|b| *b as i8).collect())
            }
            8 => Tag::String(self.string()?),
            9 => {
                let el = self.u8()?;
                let n = self.len()?;
                if el == 0 && n > 0 {
                    bail!("Corrupt NBT list");
                }
                let mut v = Vec::with_capacity(n.min(4096));
                for _ in 0..n {
                    v.push(self.payload(el, depth + 1)?);
                }
                Tag::List(el, v)
            }
            10 => {
                let mut v = vec![];
                loop {
                    let t = self.u8()?;
                    if t == 0 {
                        break;
                    }
                    let name = self.string()?;
                    v.push((name, self.payload(t, depth + 1)?));
                }
                Tag::Compound(v)
            }
            11 => {
                let n = self.len()?;
                let mut v = Vec::with_capacity(n.min(4096));
                for _ in 0..n {
                    v.push(self.i32()?);
                }
                Tag::IntArray(v)
            }
            12 => {
                let n = self.len()?;
                let mut v = Vec::with_capacity(n.min(4096));
                for _ in 0..n {
                    v.push(self.i64()?);
                }
                Tag::LongArray(v)
            }
            _ => bail!("Unknown NBT tag {id}"),
        })
    }
}

/// Parse a root compound, transparently handling gzip.
pub fn parse(data: &[u8]) -> Result<Tag> {
    let raw;
    let d = if data.starts_with(&[0x1f, 0x8b]) {
        let mut out = vec![];
        flate2::read::GzDecoder::new(data).read_to_end(&mut out)?;
        raw = out;
        &raw[..]
    } else {
        data
    };
    let mut r = Reader { d, p: 0 };
    let id = r.u8()?;
    if id != 10 {
        bail!("NBT root is not a compound");
    }
    r.string()?;
    r.payload(10, 0)
}

fn write_payload(t: &Tag, out: &mut Vec<u8>) {
    match t {
        Tag::End => {}
        Tag::Byte(v) => out.push(*v as u8),
        Tag::Short(v) => out.extend(v.to_be_bytes()),
        Tag::Int(v) => out.extend(v.to_be_bytes()),
        Tag::Long(v) => out.extend(v.to_be_bytes()),
        Tag::Float(v) => out.extend(v.to_bits().to_be_bytes()),
        Tag::Double(v) => out.extend(v.to_bits().to_be_bytes()),
        Tag::ByteArray(v) => {
            out.extend((v.len() as i32).to_be_bytes());
            out.extend(v.iter().map(|b| *b as u8));
        }
        Tag::String(s) => write_str(s, out),
        Tag::List(el, v) => {
            out.push(if v.is_empty() { *el } else { v[0].id() });
            out.extend((v.len() as i32).to_be_bytes());
            for x in v {
                write_payload(x, out);
            }
        }
        Tag::Compound(v) => {
            for (k, x) in v {
                out.push(x.id());
                write_str(k, out);
                write_payload(x, out);
            }
            out.push(0);
        }
        Tag::IntArray(v) => {
            out.extend((v.len() as i32).to_be_bytes());
            for x in v {
                out.extend(x.to_be_bytes());
            }
        }
        Tag::LongArray(v) => {
            out.extend((v.len() as i32).to_be_bytes());
            for x in v {
                out.extend(x.to_be_bytes());
            }
        }
    }
}

fn write_str(s: &str, out: &mut Vec<u8>) {
    let b = mutf8_encode(s);
    out.extend((b.len() as u16).to_be_bytes());
    out.extend(b);
}

/// Java's "modified UTF-8": NUL is two bytes and characters outside the BMP are written as
/// surrogate pairs. Plain UTF-8 would corrupt emoji in server names.
fn mutf8_decode(b: &[u8]) -> String {
    let mut units: Vec<u16> = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        if c < 0x80 {
            units.push(c as u16);
            i += 1;
        } else if c & 0xE0 == 0xC0 && i + 1 < b.len() {
            units.push((((c & 0x1F) as u16) << 6) | (b[i + 1] & 0x3F) as u16);
            i += 2;
        } else if c & 0xF0 == 0xE0 && i + 2 < b.len() {
            units.push((((c & 0x0F) as u16) << 12) | (((b[i + 1] & 0x3F) as u16) << 6) | (b[i + 2] & 0x3F) as u16);
            i += 3;
        } else if c & 0xF8 == 0xF0 && i + 3 < b.len() {
            // Real 4-byte UTF-8 (written by other tools): accept it too.
            if let Some(ch) = std::str::from_utf8(&b[i..i + 4]).ok().and_then(|s| s.chars().next()) {
                let mut buf = [0u16; 2];
                units.extend_from_slice(ch.encode_utf16(&mut buf));
            } else {
                units.push(0xFFFD);
            }
            i += 4;
        } else {
            units.push(0xFFFD);
            i += 1;
        }
    }
    String::from_utf16_lossy(&units)
}

fn mutf8_encode(s: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(s.len());
    for u in s.encode_utf16() {
        let next = match u {
            0x0001..=0x007F => 1,
            0x0000 | 0x0080..=0x07FF => 2,
            _ => 3,
        };
        if out.len() + next > u16::MAX as usize {
            break;
        }
        match next {
            1 => out.push(u as u8),
            2 => out.extend([0xC0 | (u >> 6) as u8, 0x80 | (u & 0x3F) as u8]),
            _ => out.extend([0xE0 | (u >> 12) as u8, 0x80 | ((u >> 6) & 0x3F) as u8, 0x80 | (u & 0x3F) as u8]),
        }
    }
    out
}

/// Serialize an uncompressed root compound (servers.dat format).
pub fn write(root: &Tag) -> Vec<u8> {
    let mut out = vec![10];
    write_str("", &mut out);
    write_payload(root, &mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_modified_utf8() {
        for text in ["Plain", "Caf\u{e9} \u{1F525} server", "nul\0byte"] {
            let root = Tag::Compound(vec![("name".into(), Tag::String(text.into()))]);
            let back = parse(&write(&root)).unwrap();
            assert_eq!(back.get("name").and_then(|t| t.str()), Some(text));
        }
        // Java writes U+1F525 as a surrogate pair, 6 bytes.
        assert_eq!(mutf8_encode("\u{1F525}").len(), 6);
    }

    #[test]
    fn rejects_endless_end_lists() {
        let mut d = vec![10, 0, 0, 9, 0, 1, b'x', 0];
        d.extend(i32::MAX.to_be_bytes());
        d.push(0);
        assert!(parse(&d).is_err());
    }
}
