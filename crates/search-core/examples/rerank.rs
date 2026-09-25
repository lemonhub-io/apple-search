use std::io::Read;

fn main() {
    let query = std::env::args().nth(1).expect("usage: rerank <query>");
    let mut raw = String::new();
    std::io::stdin().read_to_string(&mut raw).unwrap();
    let out = search_core::process_results(&query, js_now(), &raw);
    let v: serde_json::Value = serde_json::from_str(&out).unwrap();
    println!("intent: {}", v["intent"].as_str().unwrap());
    for (i, r) in v["results"].as_array().unwrap().iter().enumerate() {
        let title: String = r["title"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s["text"].as_str().unwrap().to_string())
            .collect();
        println!("{:>2}. [{:.3}] {} — {}", i + 1, r["score"].as_f64().unwrap(), title, r["host"].as_str().unwrap());
    }
}

fn js_now() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as f64
}
