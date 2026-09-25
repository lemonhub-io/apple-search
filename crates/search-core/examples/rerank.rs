// Ranking tuning tool: feed a real LangSearch dump through the engine.
//   cargo run --example rerank "query" < dump.json
use std::io::Read;

fn main() {
    let query = std::env::args().nth(1).unwrap_or_else(|| "test".into());
    let mut raw = String::new();
    std::io::stdin().read_to_string(&mut raw).unwrap();
    let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
    let pages = &v["data"]["webPages"]["value"];
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as f64;
    let out = search_core::process_results(&query, now, &pages.to_string());
    let parsed: serde_json::Value = serde_json::from_str(&out).unwrap();
    println!("intent: {}", parsed["intent"]);
    for r in parsed["results"].as_array().unwrap() {
        let title: String = r["title"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s["text"].as_str().unwrap_or(""))
            .collect();
        let snip: String = r["snippet"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s["text"].as_str().unwrap_or(""))
            .collect();
        println!("{:.2}  {}  [{}]", r["score"].as_f64().unwrap(), r["url"], r["date"].as_str().unwrap_or("-"));
        println!("      {}", &title[..title.len().min(80)]);
        println!("      {}", &snip[..snip.len().min(160)]);
    }
}
