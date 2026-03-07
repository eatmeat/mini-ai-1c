use tree_sitter::Parser;

pub fn create_bsl_parser() -> Parser {
    let mut parser = Parser::new();
    let language: tree_sitter::Language = tree_sitter_bsl::LANGUAGE.into();
    parser.set_language(&language).expect("Error loading BSL grammar");
    parser
}

#[derive(Debug, Clone)]
pub struct BslSymbol {
    pub name: String,
    pub kind: String,    // "procedure" | "function"
    pub start_line: u32, // 1-based
    pub end_line: u32,   // 1-based
    pub is_export: bool,
    pub calls: Vec<String>, // names of called functions/procedures
}

/// BSL keywords that appear as identifiers in calls but are not function names.
const BSL_KEYWORDS: &[&str] = &[
    "если", "иначеесли", "иначе", "конецесли",
    "пока", "конецпока", "для", "каждого", "из", "по", "конеццикла", "конецдля",
    "попытка", "исключение", "вызватьисключение", "конецпопытки",
    "возврат", "прервать", "продолжить",
    "перейти",
    "новый",
    "истина", "ложь", "неопределено", "null",
    "и", "или", "не",
    "экспорт",
    "перем",
    // English aliases
    "if", "elseif", "else", "endif",
    "while", "endwhile", "for", "each", "in", "to", "endfor",
    "try", "except", "raise", "endtry",
    "return", "break", "continue",
    "goto",
    "new",
    "true", "false", "undefined",
    "and", "or", "not",
    "export",
    "var",
];

/// Collect all `method_call` node names within a subtree (excluding nested function/proc bodies).
fn extract_calls_from_node(node: tree_sitter::Node, source: &[u8], seen: &mut std::collections::HashSet<String>, result: &mut Vec<String>) {
    let kind = node.kind();

    // Do not descend into nested function/procedure definitions
    if kind == "procedure_definition" || kind == "function_definition" {
        return;
    }

    // method_call has a `name` field with the function name identifier
    if kind == "method_call" {
        if let Some(name_node) = node.child_by_field_name("name") {
            let name = name_node.utf8_text(source).unwrap_or("").trim().to_string();
            if !name.is_empty() {
                let name_lower = name.to_lowercase();
                if !BSL_KEYWORDS.contains(&name_lower.as_str()) && !seen.contains(&name_lower) {
                    seen.insert(name_lower);
                    result.push(name);
                }
            }
        }
    }

    let child_count = node.child_count();
    for i in 0..child_count {
        if let Some(child) = node.child(i) {
            extract_calls_from_node(child, source, seen, result);
        }
    }
}

/// Extract all procedure and function definitions from BSL source code.
pub fn extract_symbols(source: &str) -> Vec<BslSymbol> {
    let mut parser = create_bsl_parser();
    let tree = match parser.parse(source, None) {
        Some(t) => t,
        None => return vec![],
    };
    let root = tree.root_node();
    let source_bytes = source.as_bytes();
    let mut symbols = Vec::new();
    traverse_for_symbols(root, source_bytes, &mut symbols);
    symbols
}

fn traverse_for_symbols(node: tree_sitter::Node, source: &[u8], symbols: &mut Vec<BslSymbol>) {
    let kind = node.kind();
    if kind == "procedure_definition" || kind == "function_definition" {
        if let Some(name_node) = node.child_by_field_name("name") {
            let name = name_node.utf8_text(source).unwrap_or("").to_string();
            if !name.is_empty() {
                let is_export = node.child_by_field_name("export").is_some();
                let start_line = node.start_position().row as u32 + 1;
                let end_line = node.end_position().row as u32 + 1;
                let sym_kind = if kind == "procedure_definition" { "procedure" } else { "function" };

                // Extract calls from function body
                let mut seen = std::collections::HashSet::new();
                let mut calls = Vec::new();
                let child_count = node.child_count();
                for i in 0..child_count {
                    if let Some(child) = node.child(i) {
                        let child_kind = child.kind();
                        // Skip the signature parts: name, parameters, export keyword
                        if child_kind != "identifier" && child_kind != "parameters" && !child_kind.contains("keyword") {
                            extract_calls_from_node(child, source, &mut seen, &mut calls);
                        }
                    }
                }

                symbols.push(BslSymbol {
                    name,
                    kind: sym_kind.to_string(),
                    start_line,
                    end_line,
                    is_export,
                    calls,
                });
            }
        }
        // Don't traverse into procedure/function body for nested defs
        return;
    }

    let child_count = node.child_count();
    for i in 0..child_count {
        if let Some(child) = node.child(i) {
            traverse_for_symbols(child, source, symbols);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_bsl_parser_initialization() {
        let mut parser = create_bsl_parser();
        let code = "Процедура Тест() КонецПроцедуры";
        let tree = parser.parse(code, None).unwrap();
        assert_eq!(tree.root_node().kind(), "source_file");
    }

    #[test]
    fn test_extract_symbols() {
        let code = "Процедура МояПроцедура() Экспорт\nКонецПроцедуры\n\nФункция МояФункция(Параметр)\n\tВозврат Параметр;\nКонецФункции\n";
        let symbols = extract_symbols(code);
        assert_eq!(symbols.len(), 2);
        assert_eq!(symbols[0].name, "МояПроцедура");
        assert_eq!(symbols[0].kind, "procedure");
        assert!(symbols[0].is_export);
        assert_eq!(symbols[1].name, "МояФункция");
        assert_eq!(symbols[1].kind, "function");
        assert!(!symbols[1].is_export);
    }

    #[test]
    fn test_extract_calls() {
        let code = "Процедура МояПроцедура()\n\tПодготовитьДанные();\n\tЗаписатьВЖурнал(\"текст\");\n\tОбъект.МойМетод();\nКонецПроцедуры\n";
        let symbols = extract_symbols(code);
        assert_eq!(symbols.len(), 1);
        let calls = &symbols[0].calls;
        assert!(calls.contains(&"ПодготовитьДанные".to_string()));
        assert!(calls.contains(&"ЗаписатьВЖурнал".to_string()));
        assert!(calls.contains(&"МойМетод".to_string()));
    }
}
