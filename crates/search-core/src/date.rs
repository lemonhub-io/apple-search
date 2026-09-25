//! Date parsing and relative labels — no chrono, keeps the wasm tiny.

/// Days between `now_ms` (epoch ms) and an ISO-8601-ish date string.
pub fn age_days(now_ms: f64, date: &str) -> Option<i64> {
    let (y, m, d) = parse_ymd(date)?;
    Some((now_ms / 86_400_000.0).floor() as i64 - days_from_civil(y, m, d))
}

/// Relative label ("3 days ago") from an ISO-8601-ish date string.
pub fn label(now_ms: f64, date: &str) -> Option<String> {
    let diff = age_days(now_ms, date)?;
    let label = match diff {
        i64::MIN..=0 => "Today".to_string(),
        1 => "Yesterday".to_string(),
        2..=6 => format!("{diff} days ago"),
        7..=29 => {
            let w = diff / 7;
            if w == 1 { "1 week ago".into() } else { format!("{w} weeks ago") }
        }
        30..=364 => {
            let mo = diff / 30;
            if mo == 1 { "1 month ago".into() } else { format!("{mo} months ago") }
        }
        _ => {
            let yr = diff / 365;
            if yr == 1 { "1 year ago".into() } else { format!("{yr} years ago") }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn civil_epoch() {
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(days_from_civil(2026, 9, 24), 20720);
    }
}
