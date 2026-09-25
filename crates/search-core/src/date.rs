//! Date parsing and labels — no chrono, keeps the wasm tiny.
//!
//! Relative labels are only meaningful when recent; for anything older than
//! a week we show the absolute date — upstream `datePublished` is crawl
//! metadata and often sits uniformly weeks stale, so fake precision
//! ("1 month ago" on every result) is worse than an honest date.

const MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/// Days between `now_ms` (epoch ms) and an ISO-8601-ish date string.
pub fn age_days(now_ms: f64, date: &str) -> Option<i64> {
    let (y, m, d) = parse_ymd(date)?;
    Some((now_ms / 86_400_000.0).floor() as i64 - days_from_civil(y, m, d))
}

/// Normalized "YYYY-MM-DD" for a parseable date — the form date operators
/// compare against.
pub fn ymd_string(date: &str) -> Option<String> {
    let (y, m, d) = parse_ymd(date)?;
    Some(format!("{y:04}-{m:02}-{d:02}"))
}

/// Display label: relative for the past week, absolute ("Sep 14" /
/// "Sep 14, 2025") beyond it.
pub fn label(now_ms: f64, date: &str) -> Option<String> {
    let diff = age_days(now_ms, date)?;
    let label = match diff {
        i64::MIN..=0 => "Today".to_string(),
        1 => "Yesterday".to_string(),
        2..=6 => format!("{diff} days ago"),
        _ => {
            let (y, m, d) = parse_ymd(date)?;
            let now_y = civil_from_days((now_ms / 86_400_000.0).floor() as i64).0;
            if y == now_y {
                format!("{} {}", MONTHS[(m - 1) as usize], d)
            } else {
                format!("{} {}, {}", MONTHS[(m - 1) as usize], d, y)
            }
        }
    };
    Some(label)
}

fn parse_ymd(date: &str) -> Option<(i64, u32, u32)> {
    let b = date.as_bytes();
    if b.len() < 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    let y = date.get(0..4)?.parse::<i64>().ok()?;
    let m = date.get(5..7)?.parse::<u32>().ok()?;
    let d = date.get(8..10)?.parse::<u32>().ok()?;
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    Some((y, m, d))
}

/// Howard Hinnant's days_from_civil — days since 1970-01-01.
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = ((m + 9) % 12) as i64;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// Inverse of days_from_civil — (year, month, day) for a day count.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn civil_epoch() {
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(days_from_civil(2026, 9, 24), 20720);
        assert_eq!(civil_from_days(20720), (2026, 9, 24));
        assert_eq!(civil_from_days(0), (1970, 1, 1));
    }

    #[test]
    fn labels() {
        let now = 20720.0 * 86_400_000.0;
        assert_eq!(label(now, "2026-09-24").as_deref(), Some("Today"));
        assert_eq!(label(now, "2026-09-23").as_deref(), Some("Yesterday"));
        assert_eq!(label(now, "2026-09-20").as_deref(), Some("4 days ago"));
        assert_eq!(label(now, "2026-08-30").as_deref(), Some("Aug 30"));
        assert_eq!(label(now, "2025-12-01").as_deref(), Some("Dec 1, 2025"));
    }
}
