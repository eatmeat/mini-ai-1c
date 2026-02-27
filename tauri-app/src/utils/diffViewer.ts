/**
 * Утилита для применения изменений в формате SEARCH/REPLACE к исходному коду.
 * Позволяет реконструировать полный текст модуля из чанка изменений.
 */
import { diffLines } from 'diff';


interface DiffBlock {
    search: string;
    replace: string;
    lineStart?: number; // Optional hint
    status?: 'pending' | 'confirmed' | 'rejected'; // Статус для UI
    index?: number; // Уникальный индекс в рамках сообщения
    stats?: {
        added: number;
        removed: number;
        modified: number;
    };
}

/**
 * Удаляет блоки кода Markdown (```...```), чтобы их содержимое не парсилось как Diff.
 * Это необходимо для случаев, когда ИИ приводит SEARCH/REPLACE просто как пример кода.
 */
function stripMarkdownCodeBlocks(content: string): string {
    return content.replace(/```[\s\S]*?```/g, '');
}

/**
 * Парсит текст сообщения на блоки изменений с поддержкой незавершенных блоков.
 */
export function parseDiffBlocks(content: string): DiffBlock[] {
    const blocks: DiffBlock[] = [];
    let index = 0;

    // Сначала парсим новый XML-формат
    // [ \t]* перед закрывающими тегами обрабатывает случай, когда ИИ делает отступ тегов (напр. "  </search>")
    const xmlRegex = /<diff>\s*<search>\n?([\s\S]*?)\n?[ \t]*<\/search>\s*<replace>\n?([\s\S]*?)\n?[ \t]*<\/replace>\s*<\/diff>/g;
    let xmlMatch;
    while ((xmlMatch = xmlRegex.exec(content)) !== null) {
        blocks.push(createBlock(
            xmlMatch[1].split('\n'),
            xmlMatch[2].split('\n'),
            index++
        ));
    }

    // Удаляем из контента распарсенные XML-блоки, чтобы они не мешали старому парсеру
    const legacyContent = content.replace(xmlRegex, '');

    const lines = legacyContent.split('\n');

    let mode: 'none' | 'search' | 'replace' = 'none';
    let searchLines: string[] = [];
    let replaceLines: string[] = [];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();

        if (trimmed.startsWith('<<<<<<< SEARCH')) {
            // Если мы уже были в блоке, закроем текущий (lenient parsing)
            if (mode === 'replace' && (searchLines.length > 0 || replaceLines.length > 0)) {
                blocks.push(createBlock(searchLines, replaceLines, index++));
            }
            mode = 'search';
            searchLines = [];
            replaceLines = [];
            continue;
        }

        if (trimmed === '=======') {
            if (mode === 'search') {
                mode = 'replace';
            }
            continue;
        }

        if (trimmed.startsWith('>>>>>>> REPLACE')) {
            if (mode === 'replace') {
                blocks.push(createBlock(searchLines, replaceLines, index++));
                mode = 'none';
                searchLines = [];
                replaceLines = [];
            }
            continue;
        }

        if (mode === 'search') {
            searchLines.push(line);
        } else if (mode === 'replace') {
            replaceLines.push(line);
        }
    }

    // В конце текста, если мы остались в режиме replace, добавляем блок
    if (mode === 'replace' && (searchLines.length > 0 || replaceLines.length > 0)) {
        blocks.push(createBlock(searchLines, replaceLines, index++));
    }

    return blocks;
}

/**
 * Вспомогательная функция для создания блока с постобработкой
 */
function createBlock(searchLines: string[], replaceLines: string[], index: number): DiffBlock {
    let search = searchLines.join('\n');
    let replace = replaceLines.join('\n');

    // Попытка извлечь метку строки из блока search (:строка:123 или :line:123)
    let lineStart: number | undefined;
    const lineMatch = search.match(/^:(строка|line):(\d+|EOF)\s*-+\s*\n/i);

    if (lineMatch) {
        search = search.substring(lineMatch[0].length);
        if (lineMatch[2] !== 'EOF') {
            lineStart = parseInt(lineMatch[2], 10);
        }
    }

    // Расчет статистики
    const dLines = diffLines(search.trim(), replace.trim(), { ignoreWhitespace: false });
    let added = 0, removed = 0;
    dLines.forEach(part => {
        const count = part.value.split('\n').filter(l => l.length > 0).length;
        if (part.added) added += count;
        else if (part.removed) removed += count;
    });
    let modified = Math.min(added, removed);
    added -= modified;
    removed -= modified;

    return {
        search,
        replace,
        lineStart,
        status: 'pending',
        index,
        stats: { added, removed, modified }
    };
}

export function applyDiff(originalCode: string, diffContent: string | DiffBlock[], selectedIndices?: number[]): string {
    if (!originalCode) return typeof diffContent === 'string' ? diffContent : originalCode;

    const blocks = typeof diffContent === 'string' ? parseDiffBlocks(diffContent) : diffContent;
    if (blocks.length === 0) return originalCode;

    const useCRLF = originalCode.includes('\r\n');
    let result = originalCode.replace(/\r\n/g, '\n');

    for (let i = 0; i < blocks.length; i++) {
        // Если указан фильтр и текущий блок не выбран - пропускаем
        if (selectedIndices && !selectedIndices.includes(blocks[i].index !== undefined ? blocks[i].index! : i)) {
            continue;
        }

        const block = blocks[i];

        let normalizedSearch = block.search.replace(/\r\n/g, '\n');
        let normalizedReplace = block.replace.replace(/\r\n/g, '\n');

        // 1. Точный поиск
        if (result.includes(normalizedSearch)) {
            result = result.replace(normalizedSearch, normalizedReplace);
            continue;
        }

        // 2. Если не нашли, и поиск заканчивается переводом строки
        if (normalizedSearch.endsWith('\n')) {
            const trimmedSearch = normalizedSearch.slice(0, -1);
            if (trimmedSearch && result.endsWith(trimmedSearch)) {
                // Если совпало в конце файла, заменяем
                const lastIndex = result.lastIndexOf(trimmedSearch);
                if (lastIndex !== -1) {
                    result = result.slice(0, lastIndex) + normalizedReplace;
                    continue;
                }
            }

            // Также пробуем просто найти trimmedSearch где угодно, если он уникальный
            const occurrences = result.split(trimmedSearch).length - 1;
            if (occurrences === 1) {
                result = result.replace(trimmedSearch, normalizedReplace);
                continue;
            }
        }

        // 3. Совсем суровый вариант: убираем пробелы в конце каждой строки поиска
        const normalizeLine = (l: string) => l.trimEnd().replace(/^\s+/, '');
        const looseSearch = normalizedSearch.split('\n').map(normalizeLine).join('\n');
        const looseOriginalLines = result.split('\n').map(normalizeLine);
        const looseOriginal = looseOriginalLines.join('\n');

        if (looseOriginal.includes(looseSearch)) {
            console.log('[applyDiff] Найдено совпадение через loose-matching');

            const searchLinesCount = normalizedSearch.split('\n').length;
            const looseSearchLines = looseSearch.split('\n');

            let replaced = false;
            // Поиск начала блока в массиве нормализованных строк
            for (let startIdx = 0; startIdx <= looseOriginalLines.length - searchLinesCount; startIdx++) {
                let match = true;
                for (let j = 0; j < searchLinesCount; j++) {
                    if (looseOriginalLines[startIdx + j] !== looseSearchLines[j]) {
                        match = false;
                        break;
                    }
                }

                if (match) {
                    // Успешная проекция! Заменяем эти строки.
                    const originalLines = result.split('\n');
                    const head = originalLines.slice(0, startIdx).join('\n');
                    const tail = originalLines.slice(startIdx + searchLinesCount).join('\n');

                    result = (head ? head + '\n' : '') + normalizedReplace + (tail ? '\n' + tail : '');
                    replaced = true;
                    break;
                }
            }
            if (replaced) continue;
        }

        // Если не нашли - выводим варнинг
        console.warn('Не удалось найти блок для замены (индекс ' + i + '):', block.search);
    }

    if (useCRLF) {
        result = result.replace(/\n/g, '\r\n');
    }

    return result;
}

/**
 * Проверяет, содержит ли сообщение блоки diff
 */
export function hasDiffBlocks(content: string): boolean {
    return /<<<<<<< SEARCH/.test(content) || /<diff>/.test(content);
}

/**
 * Проверяет, можно ли применить хотя бы один diff-блок к исходному коду.
 * Полезно для фильтрации "примеров кода", которые ИИ пишет текстом.
 */
export function hasApplicableDiffBlocks(originalCode: string, content: string): boolean {
    if (!originalCode) return false;
    const blocks = parseDiffBlocks(content);
    if (blocks.length === 0) return false;

    const normalizedOriginal = originalCode.replace(/\r\n/g, '\n');

    return blocks.some(block => {
        const normalizedSearch = block.search.replace(/\r\n/g, '\n');

        // 1. Точное совпадение
        if (normalizedOriginal.includes(normalizedSearch)) return true;

        // 2. EOF / Trimmed совпадение
        if (normalizedSearch.endsWith('\n')) {
            const trimmedSearch = normalizedSearch.slice(0, -1);
            if (trimmedSearch && (normalizedOriginal.endsWith(trimmedSearch) || normalizedOriginal.split(trimmedSearch).length === 2)) {
                return true;
            }
        }

        // 3. Loose matching
        const normalizeLine = (l: string) => l.trimEnd().replace(/^\s+/, '');
        const looseSearch = normalizedSearch.split('\n').map(normalizeLine).join('\n');
        const looseOriginalLines = normalizedOriginal.split('\n').map(normalizeLine);
        const looseOriginal = looseOriginalLines.join('\n');
        if (looseOriginal.includes(looseSearch)) return true;

        return false;
    });
}

/**
 * Очищает сообщение от технических блоков diff для отображения (если нужно скрыть)
 */
export function cleanDiffArtifacts(content: string): string {
    // Очищаем как завершенные, так и незавершенные блоки
    let cleaned = content.replace(/<<<<<<< SEARCH[\s\S]*?>>>>>>> REPLACE/g, '');
    cleaned = cleaned.replace(/<<<<<<< SEARCH[\s\S]*?=======[\s\S]*?(?:\n|$)/g, '');
    // Очищаем XML формат
    cleaned = cleaned.replace(/<diff>[\s\S]*?<\/diff>/g, '');
    cleaned = cleaned.replace(/<diff>[\s\S]*?(?:\n|$)/g, '');
    return cleaned.trim();
}

/**
 * Обрабатывает ответ ИИ с diff-блоками:
 * 1. Извлекает пояснительный текст (всё, что не является diff-блоком).
 * 2. Применяет изменения к исходному коду.
 * 3. Возвращает отформатированный Markdown: пояснения + полный код.
 */
export function processDiffResponse(originalCode: string, response: string): string {
    // 1. Извлекаем пояснения (удаляем diff-блоки)
    const explanation = cleanDiffArtifacts(response);

    // 2. Применяем изменения к коду
    const modifiedCode = applyDiff(originalCode, response);

    // 3. Формируем итоговый ответ
    let result = '';

    if (explanation) {
        result += explanation + '\n\n';
    }

    // Если код изменился или был передан, добавляем его в блок bsl
    if (modifiedCode) {
        // Добавляем заголовок, если есть пояснения, чтобы разделить контекст
        if (explanation) {
            result += '### Полный код модуля:\n';
        }
        result += '```bsl\n' + modifiedCode + '\n```';
    }

    return result;
}

/**
 * Извлекает "чистый" код для отображения в редакторе.
 * Если есть diff-блоки -> применяет их к контексту.
 * Если есть просто блоки кода -> возвращает их содержимое.
 */
export function extractDisplayCode(originalCode: string, response: string): string | null {
    // 1. Если есть diff-блоки, применяем их
    if (hasDiffBlocks(response)) {
        return applyDiff(originalCode, response);
    }

    // 2. Иначе ищем блоки кода ```bsl или ```1c
    const codeBlockRegex = /```(?:bsl|1c)([\s\S]*?)```/i;
    const match = response.match(codeBlockRegex);
    if (match) {
        return match[1].trim();
    }

    return null;
}

/**
 * Удаляет все блоки кода и diff-блоки из сообщения, оставляя только текст.
 */
export function stripCodeBlocks(content: string): string {
    // 1. Удаляем Diff-блоки (полные и частичные)
    let stripped = content.replace(/<<<<<<< SEARCH[\s\S]*?>>>>>>> REPLACE/g, '');
    stripped = stripped.replace(/<<<<<<< SEARCH[\s\S]*?=======[\s\S]*?(?:\n|$)/g, '');
    stripped = stripped.replace(/<diff>[\s\S]*?<\/diff>/g, '');
    stripped = stripped.replace(/<diff>[\s\S]*?(?:\n|$)/g, '');

    // 2. Удаляем блоки кода
    stripped = stripped.replace(/```(?:bsl|1c)([\s\S]*?)```/gi, '');

    // 3. Чистим лишние переносы
    return stripped.trim();
}
