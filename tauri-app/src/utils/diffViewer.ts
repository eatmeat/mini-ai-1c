/**
 * Утилита для применения изменений в формате SEARCH/REPLACE к исходному коду.
 * Позволяет реконструировать полный текст модуля из чанка изменений.
 */
import { diffLines } from 'diff';

// ─── Типы ──────────────────────────────────────────────────────────────────────

/** Результат применения одного блока изменений */
export type DiffApplyStatus =
    | 'applied_exact'      // Точное совпадение, применено
    | 'applied_trimmed'    // Совпадение без концевых пробелов, применено
    | 'applied_loose'      // Совпадение без учёта отступов, применено с восстановлением
    | 'applied_ws'         // Совпадение без всех пробелов (whitespace-ignored), применено
    | 'applied_fuzzy'      // Нечёткое совпадение, применено с предупреждением
    | 'failed_not_found'   // Блок не найден в исходном коде
    | 'failed_ambiguous'   // Найдено несколько совпадений
    | 'skipped';           // Пропущен (отфильтрован selectedIndices)

export interface DiffBlock {
    search: string;
    replace: string;
    lineStart?: number;
    status?: 'pending' | 'confirmed' | 'rejected';
    applyStatus?: DiffApplyStatus;
    applyError?: string;   // Человекочитаемая причина неудачи
    appliedAt?: number;    // Номер строки (1-based), где применён
    index?: number;
    stats?: {
        added: number;
        removed: number;
        modified: number;
    };
}

/** Итог применения всех блоков */
export interface DiffApplyResult {
    code: string;
    blocks: DiffBlock[];
    /** Кол-во блоков, которые не удалось применить */
    failedCount: number;
    /** Кол-во блоков, применённых нечётко (с предупреждением) */
    fuzzyCount: number;
}

// ─── Вспомогательные функции ───────────────────────────────────────────────────

/**
 * Расстояние Левенштейна между двумя строками (две строки DP, O(m*n)).
 * Для больших строк усекает до MAX_LEV_LEN для производительности.
 */
const MAX_LEV_LEN = 600;
function levenshteinDistance(a: string, b: string): number {
    if (a === b) return 0;
    if (!a) return Math.min(b.length, MAX_LEV_LEN);
    if (!b) return Math.min(a.length, MAX_LEV_LEN);
    const aS = a.length > MAX_LEV_LEN ? a.substring(0, MAX_LEV_LEN) : a;
    const bS = b.length > MAX_LEV_LEN ? b.substring(0, MAX_LEV_LEN) : b;
    const m = aS.length, n = bS.length;
    let prev = Array.from({ length: n + 1 }, (_, i) => i);
    let curr = new Array(n + 1).fill(0);
    for (let i = 1; i <= m; i++) {
        curr[0] = i;
        for (let j = 1; j <= n; j++) {
            curr[j] = aS[i - 1] === bS[j - 1]
                ? prev[j - 1]
                : 1 + Math.min(prev[j], curr[j - 1], prev[j - 1]);
        }
        [prev, curr] = [curr, prev];
    }
    return prev[n];
}

/** Вычисляет схожесть двух строк через расстояние Левенштейна: 0 = разные, 1 = идентичны */
function stringSimilarity(a: string, b: string): number {
    if (a === b) return 1;
    if (!a || !b) return 0;
    const maxLen = Math.max(
        Math.min(a.length, MAX_LEV_LEN),
        Math.min(b.length, MAX_LEV_LEN)
    );
    if (maxLen === 0) return 1;
    return 1 - levenshteinDistance(a, b) / maxLen;
}

/**
 * Считает схожесть двух блоков строк через нормализованный текст.
 * Поддерживает разное количество строк (в отличие от предыдущей позиционной реализации).
 */
function blockSimilarity(aLines: string[], bLines: string[]): number {
    const aText = aLines.map(l => l.trim()).join('\n');
    const bText = bLines.map(l => l.trim()).join('\n');
    return stringSimilarity(aText, bText);
}

/**
 * Восстанавливает относительные отступы в replace-тексте по образцу оригинала.
 * Сохраняет относительное вложение всех строк (как в Roo-Code).
 */
function restoreIndent(
    originalMatchedLines: string[],
    searchLines: string[],
    replaceText: string
): string {
    const replaceLines = replaceText.split('\n');
    const matchedBaseIndent = (originalMatchedLines[0]?.match(/^[\t ]*/) ?? [''])[0];
    const searchBaseIndent = (searchLines[0]?.match(/^[\t ]*/) ?? [''])[0];
    const searchBaseLevel = searchBaseIndent.length;

    return replaceLines.map(line => {
        if (!line.trim()) return line; // пустые строки не трогаем
        const currentIndent = (line.match(/^[\t ]*/) ?? [''])[0];
        const relativeLevel = currentIndent.length - searchBaseLevel;
        const finalIndent = relativeLevel <= 0
            ? matchedBaseIndent.slice(0, Math.max(0, matchedBaseIndent.length + relativeLevel))
            : matchedBaseIndent + currentIndent.slice(searchBaseLevel);
        return finalIndent + line.trimStart();
    }).join('\n');
}

/** Старый вариант restoreIndent для однострочных замен без контекста */
function restoreIndentSimple(originalFirstLine: string, replaceText: string): string {
    const indent = originalFirstLine.match(/^\s*/)?.[0] ?? '';
    if (!indent) return replaceText;
    return replaceText.split('\n')
        .map((line, idx) => {
            if (idx === 0 && !line.startsWith(indent)) return indent + line.trimStart();
            if (idx > 0 && line.trim() && !line.startsWith(indent)) return indent + line.trimStart();
            return line;
        })
        .join('\n');
}

/** Критичность схожести для fuzzy-принятия */
const FUZZY_THRESHOLD = 0.85;

/**
 * Стратегия whitespace-ignored: удаляет все пробельные символы и ищет совпадение.
 * Возвращает символьные позиции в оригинальном тексте или null.
 * Адаптировано из Continue.dev findSearchMatch.ts.
 */
function findWhitespaceIgnored(
    code: string,
    nSearch: string
): { startChar: number; endChar: number } | null {
    const strip = (s: string) => s.replace(/\s/g, '');
    const strippedCode = strip(code);
    const strippedSearch = strip(nSearch);
    if (!strippedSearch) return null;

    const idx = strippedCode.indexOf(strippedSearch);
    if (idx === -1) return null;

    // Строим маппинг: stripped_index → original_index
    const strippedToOrig: number[] = [];
    for (let i = 0; i < code.length; i++) {
        if (!/\s/.test(code[i])) strippedToOrig.push(i);
    }

    const endStrippedIdx = idx + strippedSearch.length - 1;
    if (idx >= strippedToOrig.length || endStrippedIdx >= strippedToOrig.length) return null;

    const startChar = strippedToOrig[idx];
    const endChar = strippedToOrig[endStrippedIdx] + 1;
    return { startChar, endChar };
}

/**
 * Стратегия dot-dot-dots: обрабатывает `...` как "пропустить строки" в SEARCH-блоке.
 * Адаптировано из Aider editblock_coder.py.
 */
function tryDotDotDots(code: string, search: string, replace: string): string | null {
    const dotLineRe = /^[ \t]*\.\.\.[ \t]*$/m;
    if (!dotLineRe.test(search)) return null;

    const splitDots = (s: string) => s.split(/^[ \t]*\.\.\.[ \t]*\r?\n?/m);
    const searchParts = splitDots(search).filter(p => p.trim());
    const replaceParts = splitDots(replace).filter(p => p.trim());

    if (searchParts.length <= 1) return null;
    if (searchParts.length !== replaceParts.length) return null;

    let result = code;
    for (let k = 0; k < searchParts.length; k++) {
        const sp = searchParts[k];
        const rp = replaceParts[k];
        const occurrences = result.split(sp).length - 1;
        if (occurrences !== 1) return null; // неоднозначно
        result = result.replace(sp, rp);
    }
    return result;
}

// ─── Создание блока ────────────────────────────────────────────────────────────

function createBlock(searchLines: string[], replaceLines: string[], index: number): DiffBlock {
    let search = searchLines.join('\n');
    let replace = replaceLines.join('\n');

    let lineStart: number | undefined;
    const lineMatch = search.match(/^:(строка|line):(\d+|EOF)\s*-+\s*\n/i);
    if (lineMatch) {
        search = search.substring(lineMatch[0].length);
        if (lineMatch[2] !== 'EOF') lineStart = parseInt(lineMatch[2], 10);
    }

    const dLines = diffLines(search.trim(), replace.trim(), { ignoreWhitespace: false });
    let added = 0, removed = 0;
    dLines.forEach(part => {
        const count = part.value.split('\n').filter(l => l.length > 0).length;
        if (part.added) added += count;
        else if (part.removed) removed += count;
    });
    const modified = Math.min(added, removed);

    return {
        search,
        replace,
        lineStart,
        status: 'pending',
        index,
        stats: { added: added - modified, removed: removed - modified, modified }
    };
}

// ─── Парсинг ───────────────────────────────────────────────────────────────────

/**
 * Парсит текст сообщения на блоки изменений с поддержкой незавершенных блоков.
 */
export function parseDiffBlocks(content: string): DiffBlock[] {
    // Normalize CRLF → LF
    content = content.replace(/\r\n/g, '\n');

    const blocks: DiffBlock[] = [];
    let index = 0;

    // Парсим XML-формат (<diff><search>...</search><replace>...</replace></diff>)
    const xmlRegex = /<diff(?:\s+[^>]*)?\>\s*<search(?:\s+[^>]*)?\>\n?([\s\S]*?)\n?[ \t]*<\/search>\s*<replace(?:\s+[^>]*)?\>\n?([\s\S]*?)\n?[ \t]*<\/replace>\s*<\/diff>/g;
    let xmlMatch;
    while ((xmlMatch = xmlRegex.exec(content)) !== null) {
        blocks.push(createBlock(xmlMatch[1].split('\n'), xmlMatch[2].split('\n'), index++));
    }

    // Парсим SEARCH/REPLACE формат (legacy)
    // Поддерживаем 5-9 символов chevron и лишний > в маркерах (Claude Sonnet 4 иногда добавляет)
    const legacyContent = content.replace(xmlRegex, '');
    const lines = legacyContent.split('\n');
    let mode: 'none' | 'search' | 'replace' = 'none';
    let searchLines: string[] = [];
    let replaceLines: string[] = [];

    for (const line of lines) {
        const trimmed = line.trim();

        if (/^<{5,9} SEARCH>?\s*$/.test(trimmed)) {
            if (mode === 'replace' && (searchLines.length > 0 || replaceLines.length > 0)) {
                blocks.push(createBlock(searchLines, replaceLines, index++));
            }
            mode = 'search'; searchLines = []; replaceLines = [];
            continue;
        }
        if (/^={5,9}\s*$/.test(trimmed)) {
            if (mode === 'search') mode = 'replace';
            continue;
        }
        if (/^>{5,9} REPLACE>?\s*$/.test(trimmed)) {
            if (mode === 'replace') {
                blocks.push(createBlock(searchLines, replaceLines, index++));
                mode = 'none'; searchLines = []; replaceLines = [];
            }
            continue;
        }

        if (mode === 'search') searchLines.push(line);
        else if (mode === 'replace') replaceLines.push(line);
    }

    if (mode === 'replace' && (searchLines.length > 0 || replaceLines.length > 0)) {
        blocks.push(createBlock(searchLines, replaceLines, index++));
    }

    return blocks;
}

// ─── Применение одного блока ───────────────────────────────────────────────────

/**
 * Пытается применить один блок к коду, используя все доступные стратегии.
 * Возвращает изменённый код и обновлённый блок со статусом.
 */
function applyBlock(code: string, block: DiffBlock): { code: string; block: DiffBlock } {
    const nSearch = block.search.replace(/\r\n/g, '\n');
    const nReplace = block.replace.replace(/\r\n/g, '\n');

    // ── Пустой SEARCH = вставить в начало файла ────────────────────────────────
    if (nSearch.trim() === '') {
        return {
            code: nReplace + (code ? '\n' + code : ''),
            block: { ...block, applyStatus: 'applied_exact', appliedAt: 1 }
        };
    }

    const originalLines = code.split('\n');
    const searchLines = nSearch.split('\n');
    // Убираем хвостовые пустые строки из SEARCH (ИИ часто ставит пустую строку перед </search>)
    while (searchLines.length > 0 && searchLines[searchLines.length - 1].trim() === '') {
        searchLines.pop();
    }
    if (searchLines.length === 0) {
        return {
            code: nReplace + (code ? '\n' + code : ''),
            block: { ...block, applyStatus: 'applied_exact', appliedAt: 1 }
        };
    }

    // ── Стратегия 0: Dot-dot-dots (`...` в SEARCH) ────────────────────────────
    const dotsResult = tryDotDotDots(code, nSearch, nReplace);
    if (dotsResult !== null) {
        const lineIdx = code.substring(0, code.indexOf(searchLines[0])).split('\n').length;
        return { code: dotsResult, block: { ...block, applyStatus: 'applied_exact', appliedAt: lineIdx } };
    }

    // ── Стратегия 1: Точное совпадение ────────────────────────────────────────
    const cleanSearch = searchLines.join('\n');
    if (code.includes(cleanSearch)) {
        const occurrences = code.split(cleanSearch).length - 1;
        if (occurrences > 1) {
            return {
                code,
                block: {
                    ...block,
                    applyStatus: 'failed_ambiguous',
                    applyError: `Найдено ${occurrences} идентичных вхождения. Уточните контекст.`
                }
            };
        }
        const lineIdx = code.substring(0, code.indexOf(cleanSearch)).split('\n').length;
        return {
            code: code.replace(cleanSearch, nReplace),
            block: { ...block, applyStatus: 'applied_exact', appliedAt: lineIdx }
        };
    }

    // ── Стратегия 2: Без концевых пробелов ────────────────────────────────────
    for (let i = 0; i <= originalLines.length - searchLines.length; i++) {
        let match = true;
        for (let j = 0; j < searchLines.length; j++) {
            if (originalLines[i + j].trimEnd() !== searchLines[j].trimEnd()) { match = false; break; }
        }
        if (match) {
            let finalReplace = nReplace;
            if (searchLines.length === 1 && !nReplace.startsWith(' ') && !nReplace.startsWith('\t')) {
                finalReplace = restoreIndentSimple(originalLines[i], nReplace);
            }
            const result = [...originalLines.slice(0, i), finalReplace, ...originalLines.slice(i + searchLines.length)].join('\n');
            return { code: result, block: { ...block, applyStatus: 'applied_trimmed', appliedAt: i + 1 } };
        }
    }

    // ── Стратегия 3: Без учёта отступов (loose) ───────────────────────────────
    const norm = (l: string) => l.trim();
    const looseSearch = searchLines.map(norm);
    const looseOriginal = originalLines.map(norm);

    for (let i = 0; i <= looseOriginal.length - searchLines.length; i++) {
        let match = true;
        for (let j = 0; j < searchLines.length; j++) {
            if (looseOriginal[i + j] !== looseSearch[j]) { match = false; break; }
        }
        if (match) {
            const finalReplace = restoreIndent(originalLines.slice(i, i + searchLines.length), searchLines, nReplace);
            const result = [...originalLines.slice(0, i), finalReplace, ...originalLines.slice(i + searchLines.length)].join('\n');
            console.log(`[applyDiff] loose-match на строке ${i + 1}`);
            return { code: result, block: { ...block, applyStatus: 'applied_loose', appliedAt: i + 1 } };
        }
    }

    // ── Стратегия 3.5: Whitespace-ignored ─────────────────────────────────────
    // Удаляем ВСЕ пробельные символы и маппим позицию обратно (из Continue.dev)
    const wsResult = findWhitespaceIgnored(code, cleanSearch);
    if (wsResult) {
        const before = code.substring(0, wsResult.startChar);
        const after = code.substring(wsResult.endChar);
        const newCode = before + nReplace + after;
        const lineIdx = before.split('\n').length;
        console.log(`[applyDiff] whitespace-ignored match на строке ${lineIdx}`);
        return { code: newCode, block: { ...block, applyStatus: 'applied_ws', appliedAt: lineIdx } };
    }

    // ── Стратегия 4: Fuzzy matching (переменное окно ±15%, Левенштейн) ────────
    // Адаптировано из Aider (переменное окно) + Roo-Code (Левенштейн)
    const scale = 0.15;
    const minLen = Math.max(1, Math.floor(searchLines.length * (1 - scale)));
    const maxLen = Math.ceil(searchLines.length * (1 + scale));

    let bestScore = 0;
    let bestIdx = -1;
    let bestLen = searchLines.length;

    for (let len = minLen; len <= maxLen; len++) {
        for (let i = 0; i <= originalLines.length - len; i++) {
            const windowLines = originalLines.slice(i, i + len);
            const score = blockSimilarity(windowLines, searchLines);
            if (score > bestScore) {
                bestScore = score;
                bestIdx = i;
                bestLen = len;
            }
        }
    }

    if (bestScore >= FUZZY_THRESHOLD && bestIdx >= 0) {
        const matchedLines = originalLines.slice(bestIdx, bestIdx + bestLen);
        const finalReplace = restoreIndent(matchedLines, searchLines, nReplace);
        const result = [...originalLines.slice(0, bestIdx), finalReplace, ...originalLines.slice(bestIdx + bestLen)].join('\n');
        console.warn(`[applyDiff] fuzzy-match на строке ${bestIdx + 1}, схожесть ${(bestScore * 100).toFixed(0)}%, окно ${bestLen} строк`);
        return {
            code: result,
            block: {
                ...block,
                applyStatus: 'applied_fuzzy',
                appliedAt: bestIdx + 1,
                applyError: `Применено через нечёткое совпадение (схожесть ${(bestScore * 100).toFixed(0)}%). Проверьте результат.`
            }
        };
    }

    // ── Провал: блок не найден ─────────────────────────────────────────────────
    const searchPreview = searchLines[0]?.trim().substring(0, 60) ?? '';
    // Подсказка: ищем наиболее похожую строку (как в Aider "did you mean")
    let hint = '';
    if (searchLines[0]?.trim()) {
        let hintBest = 0;
        let hintLine = '';
        for (const line of originalLines) {
            const s = stringSimilarity(line.trim(), searchLines[0].trim());
            if (s > hintBest && s > 0.5) { hintBest = s; hintLine = line.trim(); }
        }
        if (hintLine) hint = ` Похожая строка: "${hintLine.substring(0, 50)}"`;
    }

    return {
        code,
        block: {
            ...block,
            applyStatus: 'failed_not_found',
            applyError: `Блок не найден в исходном коде. Начало поиска: "${searchPreview}"${hint}`
        }
    };
}

// ─── Публичное API ─────────────────────────────────────────────────────────────

/**
 * Применяет изменения к коду и возвращает подробный результат с диагностикой.
 */
export function applyDiffWithDiagnostics(
    originalCode: string,
    diffContent: string | DiffBlock[],
    selectedIndices?: number[]
): DiffApplyResult {
    const blocks = typeof diffContent === 'string' ? parseDiffBlocks(diffContent) : [...diffContent];
    const useCRLF = originalCode.includes('\r\n');
    let code = originalCode.replace(/\r\n/g, '\n');
    const resultBlocks: DiffBlock[] = [];
    let failedCount = 0;
    let fuzzyCount = 0;

    for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];
        const effectiveIndex = block.index ?? i;

        if (selectedIndices && !selectedIndices.includes(effectiveIndex)) {
            resultBlocks.push({ ...block, applyStatus: 'skipped' });
            continue;
        }

        const result = applyBlock(code, block);
        code = result.code;
        resultBlocks.push(result.block);

        if (result.block.applyStatus === 'failed_not_found' || result.block.applyStatus === 'failed_ambiguous') {
            failedCount++;
        } else if (result.block.applyStatus === 'applied_fuzzy') {
            fuzzyCount++;
        }
    }

    // Убираем тройные пустые строки
    code = code.replace(/\n{3,}/g, '\n\n');
    if (useCRLF) code = code.replace(/\n/g, '\r\n');

    return { code, blocks: resultBlocks, failedCount, fuzzyCount };
}

/**
 * Упрощённый вариант (обратная совместимость) — возвращает только строку кода.
 */
export function applyDiff(originalCode: string, diffContent: string | DiffBlock[], selectedIndices?: number[]): string {
    if (!originalCode) return typeof diffContent === 'string' ? diffContent : originalCode;
    const result = applyDiffWithDiagnostics(originalCode, diffContent, selectedIndices);
    return result.code;
}

/**
 * Возвращает список блоков, которые не удалось применить.
 */
export function getDiffDiagnostics(result: DiffApplyResult): DiffBlock[] {
    return result.blocks.filter(b =>
        b.applyStatus === 'failed_not_found' ||
        b.applyStatus === 'failed_ambiguous' ||
        b.applyStatus === 'applied_fuzzy'
    );
}

/**
 * Формирует читаемое сообщение об ошибках применения для отображения в чате.
 */
export function formatDiffErrorMessage(result: DiffApplyResult): string | null {
    if (result.failedCount === 0 && result.fuzzyCount === 0) return null;

    const lines: string[] = [];

    if (result.failedCount > 0) {
        lines.push(`⚠️ **${result.failedCount} из ${result.blocks.length} блоков изменений не применены:**`);
        result.blocks
            .filter(b => b.applyStatus === 'failed_not_found' || b.applyStatus === 'failed_ambiguous')
            .forEach((b, i) => {
                const preview = b.search.trim().split('\n')[0].substring(0, 70);
                lines.push(`  ${i + 1}. ${b.applyError ?? 'Неизвестная ошибка'} \`${preview}\``);
            });
    }

    if (result.fuzzyCount > 0) {
        lines.push(`⚡ **${result.fuzzyCount} блок(а/ов) применены приблизительно (проверьте результат).**`);
    }

    return lines.join('\n');
}

// ─── Вспомогательные экспорты (обратная совместимость) ────────────────────────

/** Проверяет, содержит ли сообщение блоки diff */
export function hasDiffBlocks(content: string): boolean {
    return /<<<<<<< SEARCH/.test(content) || /<diff>/.test(content);
}

/** Проверяет, можно ли применить хотя бы один дифф-блок к исходному коду */
export function hasApplicableDiffBlocks(originalCode: string, content: string): boolean {
    if (!originalCode) return false;
    const blocks = parseDiffBlocks(content);
    if (blocks.length === 0) return false;

    const test = originalCode.replace(/\r\n/g, '\n');
    return blocks.some(block => {
        const ns = block.search.replace(/\r\n/g, '\n');
        if (test.includes(ns)) return true;
        const looseS = ns.split('\n').map(l => l.trim()).join('\n');
        const looseO = test.split('\n').map(l => l.trim()).join('\n');
        return looseO.includes(looseS);
    });
}

/** Очищает сообщение от технических блоков diff */
export function cleanDiffArtifacts(content: string): string {
    let cleaned = content.replace(/<<<<<<< SEARCH[\s\S]*?>>>>>>> REPLACE/g, '');
    cleaned = cleaned.replace(/<<<<<<< SEARCH[\s\S]*?=======[\s\S]*?(?:\n|$)/g, '');
    cleaned = cleaned.replace(/<diff>[\s\S]*?<\/diff>/g, '');
    cleaned = cleaned.replace(/<diff>[\s\S]*?(?:\n|$)/g, '');
    return cleaned.trim();
}

/** Обрабатывает ответ ИИ с diff-блоками: применяет изменения и возвращает Markdown */
export function processDiffResponse(originalCode: string, response: string): string {
    const explanation = cleanDiffArtifacts(response);
    const modifiedCode = applyDiff(originalCode, response);
    let result = '';
    if (explanation) result += explanation + '\n\n';
    if (modifiedCode) {
        if (explanation) result += '### Полный код модуля:\n';
        result += '```bsl\n' + modifiedCode + '\n```';
    }
    return result;
}

/** Извлекает код для отображения в редакторе */
export function extractDisplayCode(originalCode: string, response: string): string | null {
    if (hasDiffBlocks(response)) return applyDiff(originalCode, response);
    const match = response.match(/```(?:bsl|1c)([\s\S]*?)```/i);
    return match ? match[1].trim() : null;
}

/** Удаляет все блоки кода и diff-блоки, оставляя только текст */
export function stripCodeBlocks(content: string): string {
    let s = content.replace(/<<<<<<< SEARCH[\s\S]*?>>>>>>> REPLACE/g, '');
    s = s.replace(/<<<<<<< SEARCH[\s\S]*?=======[\s\S]*?(?:\n|$)/g, '');
    s = s.replace(/<diff>[\s\S]*?<\/diff>/g, '');
    s = s.replace(/<diff>[\s\S]*?(?:\n|$)/g, '');
    s = s.replace(/```(?:bsl|1c)([\s\S]*?)```/gi, '');
    return s.trim();
}
