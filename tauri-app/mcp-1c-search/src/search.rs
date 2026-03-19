use crate::index;
use ignore::WalkBuilder;
use regex::Regex;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::time::{Duration, Instant};

pub struct SearchResult {
    pub file: String,
    pub line: u32,
    pub snippet: String,
}

/// Compile a search pattern: literal case-insensitive or regex.
fn compile_pattern(query: &str, use_regex: bool) -> Option<Regex> {
    if use_regex {
        match Regex::new(query) {
            Ok(r) => Some(r),
            Err(e) => {
                eprintln!("[1c-search] Invalid regex '{}': {}", query, e);
                None
            }
        }
    } else {
        match Regex::new(&format!("(?i){}", regex::escape(query))) {
            Ok(r) => Some(r),
            Err(e) => {
                eprintln!("[1c-search] Regex build error: {}", e);
                None
            }
        }
    }
}

/// Search for `query` in .bsl and .xml files under `root` (or `root/sub_path` if given).
/// `use_regex` — treat query as regex; otherwise literal case-insensitive.
/// `sub_path` — optional relative sub-directory to restrict the search scope.
/// `max_ms` — optional time budget in milliseconds; if exceeded, returns partial results early.
///
/// Returns `(results, timed_out)`.
///
/// BSL-first, two-pass streaming:
/// - Pass 1: streams `.bsl` files, stops as soon as `limit` results or deadline reached.
/// - Pass 2: streams `.xml` files — only entered if Pass 1 didn't fill the limit.
///
/// Critical: does NOT collect all file paths upfront. On large configs (25K+ files)
/// on a cold HDD, collecting all metadata first would take 5-10 minutes.
/// Two-pass streaming means we stop reading as soon as we have enough results.
pub fn search_code(
    root: &Path,
    sub_path: Option<&Path>,
    query: &str,
    use_regex: bool,
    limit: usize,
    max_ms: Option<u64>,
) -> (Vec<SearchResult>, bool) {
    let pattern = match compile_pattern(query, use_regex) {
        Some(p) => p,
        None => return (vec![], false),
    };

    let search_root = match sub_path {
        Some(sub) => {
            let p = root.join(sub);
            if !p.exists() {
                eprintln!("[1c-search] Scope path not found: {}", p.display());
                return (vec![], false);
            }
            p
        }
        None => root.to_path_buf(),
    };

    let deadline = max_ms.map(|ms| Instant::now() + Duration::from_millis(ms));
    let mut results = Vec::new();
    let mut file_count = 0usize;

    // Pass 1: BSL only — streaming, early exit at limit or deadline
    'bsl: for entry in WalkBuilder::new(&search_root)
        .standard_filters(true)
        .follow_links(false)
        .build()
        .flatten()
    {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if path.extension().and_then(|e| e.to_str()) != Some("bsl") {
            continue;
        }
        file_count += 1;
        // Check deadline every 200 files (avoids clock overhead on each file)
        if file_count % 200 == 0 {
            if let Some(dl) = deadline {
                if Instant::now() >= dl {
                    return (results, true);
                }
            }
        }
        for r in search_file(path, &pattern, root) {
            results.push(r);
            if results.len() >= limit {
                break 'bsl;
            }
        }
    }

    // Pass 2: XML only — skipped entirely if BSL already filled the limit
    if results.len() < limit {
        'xml: for entry in WalkBuilder::new(&search_root)
            .standard_filters(true)
            .follow_links(false)
            .build()
            .flatten()
        {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            if path.extension().and_then(|e| e.to_str()) != Some("xml") {
                continue;
            }
            file_count += 1;
            if file_count % 200 == 0 {
                if let Some(dl) = deadline {
                    if Instant::now() >= dl {
                        return (results, true);
                    }
                }
            }
            for r in search_file(path, &pattern, root) {
                results.push(r);
                if results.len() >= limit {
                    break 'xml;
                }
            }
        }
    }

    (results, false)
}

/// Search for `query` only in the specified set of files (given as relative paths from `root`).
/// Used by index-guided search: SQLite provides candidate files, we grep only those.
pub fn search_code_in_file_set(
    root: &Path,
    rel_files: &[String],
    query: &str,
    use_regex: bool,
    limit: usize,
) -> Vec<SearchResult> {
    let pattern = match compile_pattern(query, use_regex) {
        Some(p) => p,
        None => return vec![],
    };

    let mut results = Vec::new();
    for rel_file in rel_files {
        let abs_path = root.join(rel_file);
        if !abs_path.is_file() {
            continue;
        }
        for r in search_file(&abs_path, &pattern, root) {
            results.push(r);
            if results.len() >= limit {
                return results;
            }
        }
    }
    results
}

fn search_file(path: &Path, pattern: &Regex, root: &Path) -> Vec<SearchResult> {
    let content = match index::read_file_to_string_lossy(path) {
        Ok(s) => s,
        Err(_) => return vec![],
    };

    let rel_path = path
        .strip_prefix(root)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| path.to_string_lossy().replace('\\', "/"));

    let mut results = Vec::new();
    for (idx, line) in content.lines().enumerate() {
        if pattern.is_match(line) {
            results.push(SearchResult {
                file: rel_path.clone(),
                line: (idx + 1) as u32,
                snippet: line.to_string(),
            });
        }
    }

    results
}

/// Return `radius` lines above and below `target_line` (1-based).
pub fn get_file_context(path: &Path, target_line: usize, radius: usize) -> Result<String, String> {
    let file = File::open(path).map_err(|e| format!("Не удалось открыть файл: {}", e))?;
    let lines: Vec<String> = BufReader::new(file)
        .lines()
        .map(|l| l.unwrap_or_default())
        .collect();

    let total = lines.len();
    if total == 0 {
        return Err("Файл пуст".to_string());
    }

    let target_idx = target_line.saturating_sub(1);
    if target_idx >= total {
        return Err(format!(
            "Строка {} не найдена (файл содержит {} строк)",
            target_line, total
        ));
    }

    let start = target_idx.saturating_sub(radius);
    let end = (target_idx + radius + 1).min(total);

    let mut out = format!("// {}:{}\n", path.display(), target_line);
    for (i, content) in lines[start..end].iter().enumerate() {
        let num = start + i + 1;
        let marker = if num == target_line { "→" } else { " " };
        out.push_str(&format!("{} {:4} | {}\n", marker, num, content));
    }

    Ok(out)
}

/// Per-file match summary used by impact_analysis and find_references.
pub struct FileHits {
    pub file: String,
    pub count: usize,
    pub examples: Vec<(u32, String)>, // (line_no, snippet)
}

/// Scan all `.bsl`/`.xml` files under `root` and return a per-file hit summary.
///
/// BSL-first, two-pass streaming (same strategy as `search_code`):
/// - Pass 1: `.bsl` files only — stops after `max_files` matched files or deadline.
/// - Pass 2: `.xml` files — only if Pass 1 didn't reach `max_files`.
///
/// `max_ms` — optional time budget. If exceeded, returns partial results with `timed_out=true`.
///
/// Returns `(results_sorted_by_count_desc, timed_out)`.
pub fn search_files_summary(
    root: &Path,
    query: &str,
    use_regex: bool,
    max_files: usize,
    examples_per_file: usize,
    max_ms: Option<u64>,
) -> (Vec<FileHits>, bool) {
    let pattern = if use_regex {
        match Regex::new(query) {
            Ok(r) => r,
            Err(e) => {
                eprintln!("[1c-search] Invalid regex '{}': {}", query, e);
                return (vec![], false);
            }
        }
    } else {
        match Regex::new(&format!("(?i){}", regex::escape(query))) {
            Ok(r) => r,
            Err(_) => return (vec![], false),
        }
    };

    let deadline = max_ms.map(|ms| Instant::now() + Duration::from_millis(ms));
    let mut results: Vec<FileHits> = Vec::new();
    let mut file_count = 0usize;
    let mut timed_out = false;

    // Pass 1: BSL only
    'bsl: for entry in WalkBuilder::new(root)
        .standard_filters(true)
        .follow_links(false)
        .build()
        .flatten()
    {
        if results.len() >= max_files {
            break;
        }
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if path.extension().and_then(|e| e.to_str()) != Some("bsl") {
            continue;
        }
        file_count += 1;
        if file_count % 200 == 0 {
            if let Some(dl) = deadline {
                if Instant::now() >= dl {
                    timed_out = true;
                    break 'bsl;
                }
            }
        }
        if let Some(hits) = scan_one_file_hits(path, &pattern, root, examples_per_file) {
            results.push(hits);
        }
    }

    // Pass 2: XML only — skipped if BSL already filled max_files or timed out
    if !timed_out && results.len() < max_files {
        'xml: for entry in WalkBuilder::new(root)
            .standard_filters(true)
            .follow_links(false)
            .build()
            .flatten()
        {
            if results.len() >= max_files {
                break;
            }
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            if path.extension().and_then(|e| e.to_str()) != Some("xml") {
                continue;
            }
            file_count += 1;
            if file_count % 200 == 0 {
                if let Some(dl) = deadline {
                    if Instant::now() >= dl {
                        timed_out = true;
                        break 'xml;
                    }
                }
            }
            if let Some(hits) = scan_one_file_hits(path, &pattern, root, examples_per_file) {
                results.push(hits);
            }
        }
    }

    results.sort_by(|a, b| b.count.cmp(&a.count));
    (results, timed_out)
}

/// Read one file and return FileHits if it contains at least one match.
fn scan_one_file_hits(
    path: &Path,
    pattern: &Regex,
    root: &Path,
    examples_per_file: usize,
) -> Option<FileHits> {
    let content = index::read_file_to_string_lossy(path).ok()?;
    
    let rel_path = path
        .strip_prefix(root)
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| path.to_string_lossy().replace('\\', "/"));

    let mut count = 0usize;
    let mut examples: Vec<(u32, String)> = Vec::new();

    for (idx, line) in content.lines().enumerate() {
        if pattern.is_match(line) {
            count += 1;
            if examples.len() < examples_per_file {
                examples.push(((idx + 1) as u32, line.to_string()));
            }
        }
    }

    if count > 0 {
        Some(FileHits { file: rel_path, count, examples })
    } else {
        None
    }
}

/// Считает кол-во конфигурационных файлов (`.bsl`, `.xml`) и возвращает `(count, size_in_mb)`.
#[allow(dead_code)]
pub fn count_files_and_size(root: &Path) -> (usize, f64) {
    let mut count = 0;
    let mut size_bytes = 0;

    let walker = WalkBuilder::new(root)
        .standard_filters(true)
        .follow_links(false)
        .build();

    for entry in walker.into_iter().flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }

        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
        if ext == "bsl" || ext == "xml" {
            count += 1;
            if let Ok(m) = entry.metadata() {
                size_bytes += m.len();
            }
        }
    }

    let size_mb = (size_bytes as f64) / 1024.0 / 1024.0;
    (count, size_mb)
}
