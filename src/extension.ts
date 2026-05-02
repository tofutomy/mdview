import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

let currentPanel: vscode.WebviewPanel | undefined = undefined;
let currentDocument: vscode.TextDocument | undefined = undefined;
let currentEditor: vscode.TextEditor | undefined = undefined;
let isUpdatingFromWebview = false;
// 预览区驱动编辑器滚动时，临时忽略编辑器可见区域变化，避免循环同步
let isSyncingEditorFromPreview = false;
let editorSyncLockTimeout: NodeJS.Timeout | undefined;
// 滚动同步开关
let scrollSyncEnabled = true;
// 正在编辑的标志，编辑时不触发滚动同步
let isEditing = false;
let editingTimeout: NodeJS.Timeout | undefined;

export function activate(context: vscode.ExtensionContext) {
    console.log('MD View extension is now active!');

    // 注册打开预览命令
    const openPreviewCommand = vscode.commands.registerCommand('md-view.openPreview', () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.languageId !== 'markdown') {
            vscode.window.showWarningMessage('请先打开一个 Markdown 文件');
            return;
        }
        openPreviewPanel(context, editor.document);
    });

    // 注册智能粘贴命令 - Ctrl+V
    const smartPasteCommand = vscode.commands.registerCommand('md-view.smartPaste', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.languageId !== 'markdown') {
            // 不是 markdown 文件，执行默认粘贴
            await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
            return;
        }
        await smartPaste(editor);
    });

    const insertImageFromFileCommand = vscode.commands.registerCommand('md-view.insertImageFromFile', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.languageId !== 'markdown') {
            vscode.window.showWarningMessage('请先打开一个 Markdown 文件');
            return;
        }
        const result = await insertImageFromFileAndGetMarkdown(editor.document);
        if (!result) {
            return;
        }
        await insertMarkdownAtCursorAndRefreshPreview(editor, editor.document, result.markdown);
    });

    // 监听文档变化，实时更新预览
    const onDocumentChange = vscode.workspace.onDidChangeTextDocument((e) => {
        if (currentPanel && e.document.languageId === 'markdown' && !isUpdatingFromWebview) {
            // 设置编辑标志，防止输入时触发滚动同步
            isEditing = true;
            if (editingTimeout) {
                clearTimeout(editingTimeout);
            }
            editingTimeout = setTimeout(() => {
                isEditing = false;
            }, 500);
            
            updatePreview(e.document, currentPanel);
        }
    });

    // 监听活动编辑器变化
    const onEditorChange = vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor && editor.document.languageId === 'markdown') {
            currentEditor = editor;
            currentDocument = editor.document;
            if (currentPanel) {
                updatePreview(editor.document, currentPanel);
            }
        }
    });

    // 监听编辑器可见区域变化（滚动时），使用防抖避免频繁触发
    let scrollSyncTimeout: NodeJS.Timeout | undefined;
    let lastVisibleLine = -1;
    
    const onVisibleRangeChange = vscode.window.onDidChangeTextEditorVisibleRanges((e) => {
        // 如果是从预览区同步过来的滚动，跳过
        if (isSyncingEditorFromPreview) {
            return;
        }
        // 如果滚动同步被禁用，跳过
        if (!scrollSyncEnabled) {
            return;
        }
        // 如果正在编辑，跳过（避免输入时视图跳动）
        if (isEditing) {
            return;
        }
        if (currentPanel && e.textEditor.document.languageId === 'markdown') {
            if (e.visibleRanges.length > 0) {
                const topLine = e.visibleRanges[0].start.line;
                // 只要顶部可见行发生变化就同步，保证编辑区小幅滚动时预览区也能跟随
                if (topLine !== lastVisibleLine) {
                    lastVisibleLine = topLine;
                    // 防抖：降低滚动事件频率，同时保持跟手
                    if (scrollSyncTimeout) {
                        clearTimeout(scrollSyncTimeout);
                    }
                    scrollSyncTimeout = setTimeout(() => {
                        if (currentPanel && !isSyncingEditorFromPreview) {
                            currentPanel.webview.postMessage({ command: 'syncScroll', line: topLine });
                        }
                    }, 80);
                }
            }
        }
    });

    context.subscriptions.push(
        openPreviewCommand,
        smartPasteCommand,
        insertImageFromFileCommand,
        onDocumentChange,
        onEditorChange,
        onVisibleRangeChange
    );
}

function openPreviewPanel(context: vscode.ExtensionContext, document: vscode.TextDocument) {
    const column = vscode.ViewColumn.Beside;
    currentDocument = document;
    currentEditor = vscode.window.activeTextEditor;

    if (currentPanel) {
        currentPanel.reveal(column);
        updatePreview(document, currentPanel);
        return;
    }

    currentPanel = vscode.window.createWebviewPanel(
        'mdViewPreview',
        'MD View 预览',
        column,
        {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.file(path.dirname(document.uri.fsPath)),
                vscode.Uri.file(path.join(path.dirname(document.uri.fsPath), 'images'))
            ],
            retainContextWhenHidden: true
        }
    );

    currentPanel.onDidDispose(() => {
        currentPanel = undefined;
        currentDocument = undefined;
        currentEditor = undefined;
        clearEditorSyncLock();
        isFirstLoad = true;
    }, null, context.subscriptions);

    // 处理 Webview 发来的消息
    currentPanel.webview.onDidReceiveMessage(
        async (message) => {
            if (message.command === 'scrollToLine') {
                const editor = vscode.window.activeTextEditor;
                if (editor && currentDocument && editor.document === currentDocument) {
                    const line = message.line;
                    const range = new vscode.Range(line, 0, line, 0);
                    // 使用InCenterIfOutsideViewport让标题显示在可视区上半部分
                    lockEditorSyncFromPreview();
                    editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
                    editor.selection = new vscode.Selection(line, 0, line, 0);
                }
            } else if (message.command === 'scrollEditorToLine') {
                // 预览区滚动时同步编辑器位置
                if (!scrollSyncEnabled) {
                    return;
                }
                if (currentEditor && currentDocument && currentEditor.document === currentDocument) {
                    // 设置标志防止循环同步
                    lockEditorSyncFromPreview();
                    
                    const line = message.line;
                    const range = new vscode.Range(line, 0, line, 0);
                    currentEditor.revealRange(range, vscode.TextEditorRevealType.AtTop);
                }
            } else if (message.command === 'insertImageAtCursor') {
                if (currentDocument && currentEditor) {
                    const result = await pasteImageAndGetMarkdown(currentDocument);
                    if (result) {
                        await insertMarkdownAtCursorAndRefreshPreview(currentEditor, currentDocument, result.markdown);
                    }
                } else {
                    vscode.window.showWarningMessage('请先在编辑器中点击光标位置');
                }
            } else if (message.command === 'insertImageFromFileAtCursor') {
                if (currentDocument && currentEditor) {
                    const result = await insertImageFromFileAndGetMarkdown(currentDocument);
                    if (result) {
                        await insertMarkdownAtCursorAndRefreshPreview(currentEditor, currentDocument, result.markdown);
                    }
                } else {
                    vscode.window.showWarningMessage('请先在编辑器中点击光标位置');
                }
            } else if (message.command === 'updateContent') {
                // 从 Webview 接收编辑后的内容，更新源文件并刷新预览
                if (currentDocument && currentPanel) {
                    isUpdatingFromWebview = true;
                    const edit = new vscode.WorkspaceEdit();
                    const fullRange = new vscode.Range(
                        currentDocument.positionAt(0),
                        currentDocument.positionAt(currentDocument.getText().length)
                    );
                    edit.replace(currentDocument.uri, fullRange, message.content);
                    await vscode.workspace.applyEdit(edit);
                    isUpdatingFromWebview = false;
                    
                    // 使用传入的内容直接更新预览，不依赖文件读取
                    updatePreviewWithContent(message.content, currentDocument, currentPanel);
                }
            } else if (message.command === 'pasteImage') {
                // 在预览界面粘贴图片
                if (currentDocument) {
                    const result = await pasteImageAndGetMarkdown(currentDocument);
                    if (result) {
                        currentPanel?.webview.postMessage({ 
                            command: 'insertImage', 
                            markdown: result.markdown,
                            cursorPosition: message.cursorPosition
                        });
                    }
                }
            } else if (message.command === 'setScrollSync') {
                // 设置滚动同步状态
                scrollSyncEnabled = message.enabled;
            }
        },
        undefined,
        context.subscriptions
    );

    updatePreview(document, currentPanel);
}

function lockEditorSyncFromPreview() {
    isSyncingEditorFromPreview = true;
    if (editorSyncLockTimeout) {
        clearTimeout(editorSyncLockTimeout);
    }
    editorSyncLockTimeout = setTimeout(() => {
        isSyncingEditorFromPreview = false;
        editorSyncLockTimeout = undefined;
    }, 450);
}

function clearEditorSyncLock() {
    if (editorSyncLockTimeout) {
        clearTimeout(editorSyncLockTimeout);
        editorSyncLockTimeout = undefined;
    }
    isSyncingEditorFromPreview = false;
}

let isFirstLoad = true;

function updatePreview(document: vscode.TextDocument, panel: vscode.WebviewPanel) {
    const content = document.getText();
    updatePreviewWithContent(content, document, panel);
}

function updatePreviewWithContent(content: string, document: vscode.TextDocument, panel: vscode.WebviewPanel) {
    const { html, toc } = parseMarkdown(content, document, panel.webview);
    const docDir = path.dirname(document.uri.fsPath);
    
    if (isFirstLoad) {
        // 首次加载，设置完整 HTML
        panel.webview.html = getWebviewContent(html, toc, content, docDir, panel.webview);
        isFirstLoad = false;
    } else {
        // 增量更新，只更新内容部分，保持滚动位置
        panel.webview.postMessage({ 
            command: 'updatePreviewContent', 
            html: html,
            toc: toc,
            rawContent: content
        });
    }
}

interface TocItem {
    level: number;
    text: string;
    line: number;
}

function parseMarkdown(content: string, document: vscode.TextDocument, webview: vscode.Webview): { html: string; toc: TocItem[] } {
    const lines = content.split('\n');
    const toc: TocItem[] = [];
    let html = '';
    let inCodeBlock = false;
    let inTable = false;
    let tableHtml = '';
    const docDir = path.dirname(document.uri.fsPath);

    for (let i = 0; i < lines.length; i++) {
        let line = lines[i];

        // 检测代码块
        if (line.trim().startsWith('```')) {
            inCodeBlock = !inCodeBlock;
            if (inCodeBlock) {
                const lang = line.trim().slice(3);
                html += `<pre><code class="language-${lang}">`;
            } else {
                html += '</code></pre>\n';
            }
            continue;
        }

        if (inCodeBlock) {
            html += escapeHtml(line) + '\n';
            continue;
        }

        // 检测表格
        const isTableRow = line.trim().startsWith('|') && line.trim().endsWith('|');
        const isSeparatorRow = /^\|[\s\-:|]+\|$/.test(line.trim());
        
        if (isTableRow) {
            if (!inTable) {
                inTable = true;
                tableHtml = '<table>\n';
            }
            
            if (isSeparatorRow) {
                // 分隔行，跳过但继续表格
                continue;
            }
            
            const cells = line.trim().slice(1, -1).split('|').map(cell => cell.trim());
            const isHeader = i + 1 < lines.length && /^\|[\s\-:|]+\|$/.test(lines[i + 1].trim());
            
            if (isHeader) {
                tableHtml += '<thead><tr>';
                cells.forEach(cell => {
                    tableHtml += `<th>${parseInlineMarkdown(cell, docDir, webview)}</th>`;
                });
                tableHtml += '</tr></thead>\n<tbody>\n';
            } else {
                tableHtml += '<tr>';
                cells.forEach(cell => {
                    tableHtml += `<td>${parseInlineMarkdown(cell, docDir, webview)}</td>`;
                });
                tableHtml += '</tr>\n';
            }
            continue;
        } else if (inTable) {
            // 表格结束
            inTable = false;
            tableHtml += '</tbody></table>\n';
            html += tableHtml;
            tableHtml = '';
        }

        // 解析标题 - 支持 # 后有或无空格，目录只收集1-4级
        const trimmedLine = line.trim();
        const headingMatch = trimmedLine.match(/^(#{1,6})\s*(.+)$/);
        if (headingMatch && !trimmedLine.startsWith('#######')) {
            const level = headingMatch[1].length;
            const text = headingMatch[2].trim();
            if (text) {
                // 目录只显示1-4级标题
                if (level <= 4) {
                    toc.push({ level, text, line: i });
                }
                html += `<h${level} id="line-${i}" class="heading" data-line="${i}">${escapeHtml(text)}</h${level}>\n`;
                continue;
            }
        }

        // 使用内联解析
        line = parseInlineMarkdown(line, docDir, webview);

        // 解析无序列表
        if (lines[i].match(/^[-*+]\s+/)) {
            line = '<li>' + line.replace(/^[-*+]\s+/, '').replace(/^<[^>]+>[-*+]\s+/, '') + '</li>';
        }

        // 解析有序列表
        if (lines[i].match(/^\d+\.\s+/)) {
            line = '<li>' + line.replace(/^\d+\.\s+/, '').replace(/^<[^>]+>\d+\.\s+/, '') + '</li>';
        }

        // 解析引用
        if (lines[i].startsWith('>')) {
            const quoteContent = line.replace(/^>?\s*/, '');
            line = '<blockquote>' + quoteContent + '</blockquote>';
        }

        // 解析分割线
        if (lines[i].match(/^[-*_]{3,}$/)) {
            line = '<hr>';
        }

        // 空行转为段落
        if (lines[i].trim() === '') {
            html += '<br>\n';
        } else {
            html += `<p data-line="${i}">${line}</p>\n`;
        }
    }

    // 如果文件以表格结尾
    if (inTable) {
        tableHtml += '</tbody></table>\n';
        html += tableHtml;
    }

    return { html, toc };
}

// 解析内联 Markdown 元素
function parseInlineMarkdown(line: string, docDir: string, webview: vscode.Webview): string {
    // 解析图片
    line = line.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, src) => {
        let imageSrc = src;
        if (!src.startsWith('http://') && !src.startsWith('https://')) {
            const imagePath = path.resolve(docDir, src);
            if (fs.existsSync(imagePath)) {
                imageSrc = webview.asWebviewUri(vscode.Uri.file(imagePath)).toString();
            }
        }
        return `<img src="${imageSrc}" alt="${escapeHtml(alt)}" style="max-width:100%;">`;
    });

    // 解析链接
    line = line.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

    // 解析粗体
    line = line.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    line = line.replace(/__([^_]+)__/g, '<strong>$1</strong>');

    // 解析斜体
    line = line.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    line = line.replace(/_([^_]+)_/g, '<em>$1</em>');

    // 解析行内代码
    line = line.replace(/`([^`]+)`/g, '<code>$1</code>');

    return line;
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// 生成可折叠的目录 HTML
function generateTocHtml(toc: TocItem[]): string {
    if (toc.length === 0) {
        return '<div class="no-toc">暂无标题</div>';
    }

    let html = '';
    let tocIndex = 0;

    function buildTocTree(parentLevel: number): string {
        let result = '';
        while (tocIndex < toc.length) {
            const item = toc[tocIndex];
            
            if (item.level <= parentLevel) {
                break;
            }
            
            // 检查是否有子项
            const hasChildren = tocIndex + 1 < toc.length && toc[tocIndex + 1].level > item.level;
            const indent = (item.level - 1) * 16;
            
            if (hasChildren) {
                result += `<div class="toc-group" data-level="${item.level}">`;
                result += `<div class="toc-item" style="padding-left: ${indent}px;" data-line="${item.line}">`;
                result += `<span class="toc-toggle" onclick="toggleToc(event, this)">▼</span>`;
                result += `<span class="toc-text" onclick="scrollToLine(${item.line})">${escapeHtml(item.text)}</span>`;
                result += `</div>`;
                result += `<div class="toc-children">`;
                tocIndex++;
                result += buildTocTree(item.level);
                result += `</div></div>`;
            } else {
                result += `<div class="toc-item" style="padding-left: ${indent}px;" data-line="${item.line}">`;
                result += `<span class="toc-toggle-placeholder"></span>`;
                result += `<span class="toc-text" onclick="scrollToLine(${item.line})">${escapeHtml(item.text)}</span>`;
                result += `</div>`;
                tocIndex++;
            }
        }
        return result;
    }

    html = buildTocTree(0);
    return html;
}

function getWebviewContent(html: string, toc: TocItem[], rawContent: string, docDir: string, webview: vscode.Webview): string {
    const tocHtml = generateTocHtml(toc);

    // 转义用于 JavaScript 字符串的内容
    const escapedContent = rawContent
        .replace(/\\/g, '\\\\')
        .replace(/`/g, '\\`')
        .replace(/\$/g, '\\$');
    
    // 将 toc 数据转换为 JSON 传递给 webview
    const tocJson = JSON.stringify(toc).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>MD View 预览</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
            display: flex;
            height: 100vh;
            overflow: hidden;
            background: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
        }
        .sidebar {
            width: 250px;
            min-width: 180px;
            max-width: 400px;
            border-right: 1px solid var(--vscode-panel-border);
            overflow-y: auto;
            padding: 12px;
            background: var(--vscode-sideBar-background);
            flex-shrink: 0;
        }
        .sidebar-title {
            font-weight: bold;
            margin-bottom: 12px;
            padding-bottom: 8px;
            border-bottom: 1px solid var(--vscode-panel-border);
            color: var(--vscode-sideBarTitle-foreground);
            font-size: 14px;
        }
        .toc-group {
            margin-bottom: 0;
        }
        .toc-item {
            padding: 4px 8px 4px 0;
            cursor: pointer;
            border-radius: 4px;
            margin-bottom: 1px;
            font-size: 13px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            color: var(--vscode-foreground);
            display: flex;
            align-items: center;
        }
        .toc-item .toc-text {
            flex: 1;
            overflow: hidden;
            text-overflow: ellipsis;
            cursor: pointer;
        }
        .toc-toggle, .toc-toggle-placeholder {
            width: 16px;
            height: 16px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            font-size: 10px;
            color: var(--vscode-foreground);
            opacity: 0.7;
            flex-shrink: 0;
        }
        .toc-toggle {
            cursor: pointer;
        }
        .toc-toggle:hover {
            opacity: 1;
        }
        .toc-toggle.collapsed {
            transform: rotate(-90deg);
        }
        .toc-children {
            overflow: hidden;
            transition: max-height 0.2s ease-out;
        }
        .toc-children.collapsed {
            max-height: 0 !important;
        }
        .toc-item:hover {
            background: var(--vscode-list-hoverBackground);
        }
        .main-area {
            flex: 1;
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }
        .toolbar {
            padding: 8px 16px;
            border-bottom: 1px solid var(--vscode-panel-border);
            display: flex;
            gap: 8px;
            align-items: center;
            background: var(--vscode-editor-background);
        }
        .toolbar button {
            padding: 6px 12px;
            border: 1px solid var(--vscode-button-border, var(--vscode-panel-border));
            background: var(--vscode-button-secondaryBackground);
            color: var(--vscode-button-secondaryForeground);
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
        }
        .toolbar button:hover {
            background: var(--vscode-button-secondaryHoverBackground);
        }
        .toolbar button.active {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
        }
        .content-area {
            flex: 1;
            overflow: hidden;
            position: relative;
        }
        .preview-content {
            height: 100%;
            overflow-y: auto;
            padding: 24px;
        }
        .edit-content {
            height: 100%;
            display: none;
        }
        .edit-content.active {
            display: block;
        }
        .preview-content.hidden {
            display: none;
        }
        .editor-textarea {
            width: 100%;
            height: 100%;
            padding: 16px;
            border: none;
            resize: none;
            font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
            font-size: 14px;
            line-height: 1.6;
            background: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
            outline: none;
        }
        h1, h2, h3, h4, h5, h6 {
            margin-top: 24px;
            margin-bottom: 16px;
            font-weight: 600;
            line-height: 1.25;
        }
        h1 { font-size: 2em; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 0.3em; }
        h2 { font-size: 1.5em; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 0.3em; }
        h3 { font-size: 1.25em; }
        h4 { font-size: 1em; }
        h5 { font-size: 0.875em; }
        h6 { font-size: 0.85em; color: var(--vscode-descriptionForeground); }
        p {
            margin-bottom: 16px;
            line-height: 1.6;
        }
        code {
            background: var(--vscode-textCodeBlock-background);
            padding: 2px 6px;
            border-radius: 3px;
            font-family: 'Consolas', 'Monaco', monospace;
            font-size: 0.9em;
        }
        pre {
            background: var(--vscode-textCodeBlock-background);
            padding: 16px;
            border-radius: 6px;
            overflow-x: auto;
            margin-bottom: 16px;
        }
        pre code {
            background: none;
            padding: 0;
        }
        blockquote {
            border-left: 4px solid var(--vscode-textBlockQuote-border);
            padding-left: 16px;
            color: var(--vscode-textBlockQuote-foreground);
            margin-bottom: 16px;
        }
        img {
            max-width: 100%;
            height: auto;
            border-radius: 4px;
            margin: 8px 0;
            cursor: pointer;
            transition: transform 0.2s;
        }
        img:hover {
            transform: scale(1.02);
        }
        /* 图片查看大图模态框 */
        .image-modal {
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.9);
            z-index: 1000;
            justify-content: center;
            align-items: center;
            cursor: zoom-out;
        }
        .image-modal.active {
            display: flex;
        }
        .image-modal img {
            max-width: 95%;
            max-height: 95%;
            object-fit: contain;
            border-radius: 8px;
            cursor: default;
        }
        .image-modal-close {
            position: absolute;
            top: 20px;
            right: 30px;
            font-size: 36px;
            color: white;
            cursor: pointer;
            z-index: 1001;
            opacity: 0.8;
        }
        .image-modal-close:hover {
            opacity: 1;
        }
        a {
            color: var(--vscode-textLink-foreground);
            text-decoration: none;
        }
        a:hover {
            text-decoration: underline;
        }
        li {
            margin-left: 24px;
            margin-bottom: 4px;
        }
        hr {
            border: none;
            border-top: 1px solid var(--vscode-panel-border);
            margin: 24px 0;
        }
        strong {
            font-weight: 600;
        }
        table {
            border-collapse: collapse;
            width: 100%;
            margin: 16px 0;
        }
        th, td {
            border: 1px solid var(--vscode-panel-border);
            padding: 8px 12px;
            text-align: left;
        }
        th {
            background: var(--vscode-editor-selectionBackground);
            font-weight: 600;
        }
        tr:nth-child(even) {
            background: var(--vscode-list-hoverBackground);
        }
        .heading {
            cursor: pointer;
        }
        .heading:hover {
            color: var(--vscode-textLink-foreground);
        }
        .highlight {
            background: var(--vscode-editor-findMatchHighlightBackground);
            animation: fadeOut 2s forwards;
        }
        /* 滚动同步复选框样式 */
        .sync-checkbox-wrapper {
            display: flex;
            align-items: center;
            gap: 4px;
            font-size: 12px;
            color: var(--vscode-foreground);
            cursor: pointer;
            user-select: none;
        }
        .sync-checkbox-wrapper input[type="checkbox"] {
            width: 14px;
            height: 14px;
            cursor: pointer;
            accent-color: var(--vscode-button-background);
        }
        @keyframes fadeOut {
            from { background: var(--vscode-editor-findMatchHighlightBackground); }
            to { background: transparent; }
        }
        .no-toc {
            color: var(--vscode-descriptionForeground);
            font-size: 12px;
            padding: 8px;
        }
    </style>
</head>
<body>
    <div class="sidebar">
        <div class="sidebar-title">📑 目录</div>
        <div id="toc-container">
            ${tocHtml || '<div class="no-toc">暂无标题</div>'}
        </div>
    </div>
    <div class="main-area">
        <div class="toolbar">
            <button id="insertImageBtn" onclick="insertImage()">📷 粘贴图片</button>
            <button id="insertImageFromFileBtn" onclick="insertImageFromFile()">🖼 插入图片</button>
            <label class="sync-checkbox-wrapper">
                <input type="checkbox" id="scrollSyncCheckbox" checked onchange="toggleScrollSync(this.checked)">
                <span>滚动同步</span>
            </label>
            <span style="margin-left: auto; font-size: 12px; color: var(--vscode-descriptionForeground);">
                粘贴剪贴板｜本机选图插入
            </span>
        </div>
        <div class="content-area">
            <div class="preview-content" id="preview">
                ${html}
            </div>
        </div>
    </div>
    <!-- 图片查看大图模态框 -->
    <div class="image-modal" id="imageModal" onclick="closeImageModal(event)">
        <span class="image-modal-close" onclick="closeImageModal(event)">&times;</span>
        <img id="modalImage" src="" alt="">
    </div>
    <script>
        const vscode = acquireVsCodeApi();
        let editorContent = \`${escapedContent}\`;
        let tocData = ${tocJson};
        let scrollSyncEnabled = true;
        let isSyncingPreviewFromEditor = false;
        let previewSyncUnlockTimer = undefined;
        let lastPreviewSyncedLine = -1;
        let lastEditorSyncedLine = -1;
        
        const previewDiv = document.getElementById('preview');

        function lockPreviewSyncFromEditor() {
            isSyncingPreviewFromEditor = true;
            clearTimeout(previewSyncUnlockTimer);
            previewSyncUnlockTimer = setTimeout(() => {
                isSyncingPreviewFromEditor = false;
            }, 500);
        }

        function keepPreviewSyncLockedUntilScrollSettles() {
            clearTimeout(previewSyncUnlockTimer);
            previewSyncUnlockTimer = setTimeout(() => {
                isSyncingPreviewFromEditor = false;
            }, 300);
        }

        // 切换滚动同步
        function toggleScrollSync(enabled) {
            scrollSyncEnabled = enabled;
            vscode.postMessage({ command: 'setScrollSync', enabled: enabled });
        }

        // 目录折叠功能
        function toggleToc(event, toggleEl) {
            event.stopPropagation();
            const group = toggleEl.closest('.toc-group');
            const children = group.querySelector('.toc-children');
            
            if (toggleEl.classList.contains('collapsed')) {
                toggleEl.classList.remove('collapsed');
                toggleEl.textContent = '▼';
                children.classList.remove('collapsed');
                children.style.maxHeight = children.scrollHeight + 'px';
            } else {
                toggleEl.classList.add('collapsed');
                toggleEl.textContent = '▶';
                children.classList.add('collapsed');
            }
        }

        // 初始化目录高度
        function initTocHeights() {
            document.querySelectorAll('.toc-children').forEach(el => {
                el.style.maxHeight = el.scrollHeight + 'px';
            });
        }
        initTocHeights();

        function insertImage() {
            vscode.postMessage({ command: 'insertImageAtCursor' });
        }

        function insertImageFromFile() {
            vscode.postMessage({ command: 'insertImageFromFileAtCursor' });
        }

        // 图片查看大图功能
        function openImageModal(src) {
            const modal = document.getElementById('imageModal');
            const modalImg = document.getElementById('modalImage');
            modalImg.src = src;
            modal.classList.add('active');
        }

        function closeImageModal(event) {
            // 如果点击的是图片本身，不关闭
            if (event.target.id === 'modalImage') {
                return;
            }
            const modal = document.getElementById('imageModal');
            modal.classList.remove('active');
        }

        // 为预览区图片添加点击事件
        function initImageClickHandlers() {
            previewDiv.querySelectorAll('img').forEach(img => {
                img.onclick = function(e) {
                    e.preventDefault();
                    openImageModal(this.src);
                };
            });
        }
        initImageClickHandlers();

        // 按ESC键关闭模态框
        document.addEventListener('keydown', function(e) {
            if (e.key === 'Escape') {
                closeImageModal(e);
            }
        });

        function scrollToLine(line) {
            const element = document.querySelector('#preview [data-line="' + line + '"]');
            if (element) {
                // 获取预览容器
                const container = document.getElementById('preview');
                // 计算元素相对于容器的位置，让标题显示在可视区上半部分（约1/4处）
                const containerHeight = container.clientHeight;
                const elementTop = element.offsetTop;
                const scrollTarget = elementTop - containerHeight * 0.2;
                container.scrollTo({
                    top: Math.max(0, scrollTarget),
                    behavior: 'smooth'
                });
                element.classList.add('highlight');
                setTimeout(() => element.classList.remove('highlight'), 2000);
            }
            // 同步编辑器滚动
            vscode.postMessage({ command: 'scrollToLine', line: line });
        }

        // 点击标题时同步到编辑器
        document.querySelectorAll('.heading').forEach(heading => {
            heading.addEventListener('click', () => {
                const line = parseInt(heading.getAttribute('data-line'));
                scrollToLine(line);
            });
        });

        // 监听预览区滚动，同步到编辑器
        let scrollSyncTimeout;
        previewDiv.addEventListener('scroll', () => {
            if (!scrollSyncEnabled) return;
            if (isSyncingPreviewFromEditor) {
                clearTimeout(scrollSyncTimeout);
                keepPreviewSyncLockedUntilScrollSettles();
                return;
            }
            clearTimeout(scrollSyncTimeout);
            scrollSyncTimeout = setTimeout(() => {
                if (!scrollSyncEnabled) return;
                if (isSyncingPreviewFromEditor) return;
                // 找到当前可见区域顶部附近的元素
                const elements = previewDiv.querySelectorAll('[data-line]');
                const scrollTop = previewDiv.scrollTop;
                let closestElement = null;
                let closestDistance = Infinity;
                
                elements.forEach(el => {
                    const distance = Math.abs(el.offsetTop - scrollTop - 50);
                    if (distance < closestDistance) {
                        closestDistance = distance;
                        closestElement = el;
                    }
                });
                
                if (closestElement) {
                    const line = parseInt(closestElement.getAttribute('data-line'));
                    if (!Number.isNaN(line) && line !== lastEditorSyncedLine) {
                        lastEditorSyncedLine = line;
                        vscode.postMessage({ command: 'scrollEditorToLine', line: line });
                    }
                }
            }, 80);
        });

        // 监听来自扩展的消息
        window.addEventListener('message', event => {
            const message = event.data;
            if (message.command === 'syncScroll') {
                // 从 VS Code 编辑器同步滚动位置
                if (scrollSyncEnabled) {
                    const line = message.line;
                    if (line !== lastPreviewSyncedLine) {
                        lastPreviewSyncedLine = line;
                        syncScrollToLine(line);
                    }
                }
            } else if (message.command === 'scrollToInsertedImage') {
                // 滚动到新插入的图片位置
                setTimeout(() => {
                    const images = previewDiv.querySelectorAll('img');
                    if (images.length > 0) {
                        // 找到最接近指定行的图片
                        let targetImg = images[images.length - 1]; // 默认最后一个
                        const targetLine = message.line;
                        images.forEach(img => {
                            const parent = img.closest('[data-line]');
                            if (parent) {
                                const imgLine = parseInt(parent.getAttribute('data-line'));
                                if (imgLine >= targetLine) {
                                    targetImg = img;
                                }
                            }
                        });
                        targetImg.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    }
                }, 200);
            } else if (message.command === 'updatePreviewContent') {
                // 增量更新预览内容，保持滚动位置
                const scrollTop = previewDiv.scrollTop;
                previewDiv.innerHTML = message.html;
                editorContent = message.rawContent;
                // 更新目录（带折叠功能）
                const tocContainer = document.getElementById('toc-container');
                if (tocContainer && message.toc) {
                    tocData = message.toc;
                    tocContainer.innerHTML = buildTocHtml(message.toc);
                    initTocHeights();
                }
                // 恢复滚动位置
                previewDiv.scrollTop = scrollTop;
                // 重新绑定图片点击事件
                initImageClickHandlers();
            }
        });

        // 生成可折叠目录 HTML
        function buildTocHtml(toc) {
            if (!toc || toc.length === 0) {
                return '<div class="no-toc">暂无标题</div>';
            }
            
            let tocIndex = 0;
            
            function buildTree(parentLevel) {
                let result = '';
                while (tocIndex < toc.length) {
                    const item = toc[tocIndex];
                    
                    if (item.level <= parentLevel) {
                        break;
                    }
                    
                    const hasChildren = tocIndex + 1 < toc.length && toc[tocIndex + 1].level > item.level;
                    const indent = (item.level - 1) * 16;
                    
                    if (hasChildren) {
                        result += '<div class="toc-group" data-level="' + item.level + '">';
                        result += '<div class="toc-item" style="padding-left: ' + indent + 'px;" data-line="' + item.line + '">';
                        result += '<span class="toc-toggle" onclick="toggleToc(event, this)">▼</span>';
                        result += '<span class="toc-text" onclick="scrollToLine(' + item.line + ')">' + escapeHtmlJs(item.text) + '</span>';
                        result += '</div>';
                        result += '<div class="toc-children">';
                        tocIndex++;
                        result += buildTree(item.level);
                        result += '</div></div>';
                    } else {
                        result += '<div class="toc-item" style="padding-left: ' + indent + 'px;" data-line="' + item.line + '">';
                        result += '<span class="toc-toggle-placeholder"></span>';
                        result += '<span class="toc-text" onclick="scrollToLine(' + item.line + ')">' + escapeHtmlJs(item.text) + '</span>';
                        result += '</div>';
                        tocIndex++;
                    }
                }
                return result;
            }
            
            return buildTree(0);
        }
        
        function escapeHtmlJs(text) {
            return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        }

        // 滚动同步函数 - 找到最近的有 data-line 属性的元素
        function syncScrollToLine(targetLine) {
            const container = document.getElementById('preview');
            const elements = container.querySelectorAll('[data-line]');
            let closestElement = null;
            let closestDistance = Infinity;
            
            elements.forEach(el => {
                const elLine = parseInt(el.getAttribute('data-line'));
                const distance = Math.abs(elLine - targetLine);
                if (distance < closestDistance) {
                    closestDistance = distance;
                    closestElement = el;
                }
            });
            
            if (closestElement) {
                const elementTop = closestElement.offsetTop;
                lastEditorSyncedLine = targetLine;
                lockPreviewSyncFromEditor();
                container.scrollTo({
                    top: elementTop - 50,
                    behavior: 'auto'
                });
            }
        }
    </script>
</body>
</html>`;
}

async function insertMarkdownAtCursorAndRefreshPreview(
    editor: vscode.TextEditor,
    document: vscode.TextDocument,
    markdown: string
): Promise<boolean> {
    const position = editor.selection.active;
    const insertLine = position.line;
    const success = await editor.edit((editBuilder) => {
        editBuilder.insert(position, markdown);
    });
    if (success && currentPanel && currentDocument === document) {
        updatePreview(document, currentPanel);
        setTimeout(() => {
            currentPanel?.webview.postMessage({ command: 'scrollToInsertedImage', line: insertLine });
        }, 100);
    }
    return success;
}

async function insertImageFromFileAndGetMarkdown(
    document: vscode.TextDocument
): Promise<{ markdown: string } | null> {
    if (document.uri.scheme !== 'file') {
        vscode.window.showWarningMessage('请先保存 Markdown 文件到本地后再插入图片');
        return null;
    }
    const docDir = path.dirname(document.uri.fsPath);
    const imagesDir = path.join(docDir, 'images');
    const uris = await vscode.window.showOpenDialog({
        canSelectMany: true,
        openLabel: '插入',
        defaultUri: vscode.Uri.file(docDir),
        filters: {
            图片: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico']
        }
    });
    if (!uris?.length) {
        return null;
    }

    const resolvedDocDir = path.resolve(docDir);
    const resolvedImagesDir = path.resolve(imagesDir);
    const baseStamp = new Date().toISOString().replace(/[:.]/g, '-');
    const lines: string[] = [];
    const errors: string[] = [];

    for (let i = 0; i < uris.length; i++) {
        const srcPath = uris[i].fsPath;
        try {
            const resolvedSrc = path.resolve(srcPath);
            const relUnderImages = path.relative(resolvedImagesDir, resolvedSrc);
            const alreadyInDocumentImages =
                relUnderImages !== '' &&
                !relUnderImages.startsWith('..') &&
                !path.isAbsolute(relUnderImages);

            if (alreadyInDocumentImages) {
                const relativePath = path.relative(resolvedDocDir, resolvedSrc).replace(/\\/g, '/');
                if (relativePath.startsWith('..') || !relativePath) {
                    errors.push(`${path.basename(srcPath)}: 无法计算相对路径`);
                    continue;
                }
                lines.push(`![image](${relativePath})`);
            } else {
                if (!fs.existsSync(imagesDir)) {
                    fs.mkdirSync(imagesDir, { recursive: true });
                }
                const ext = path.extname(srcPath) || '.png';
                const destName = `image-${baseStamp}-${i}${ext}`;
                const destPath = path.join(imagesDir, destName);
                await fs.promises.copyFile(srcPath, destPath);
                const relativePath = `images/${destName}`.replace(/\\/g, '/');
                lines.push(`![image](${relativePath})`);
            }
        } catch (error) {
            errors.push(`${path.basename(srcPath)}: ${(error as Error).message}`);
        }
    }

    if (lines.length === 0) {
        if (errors.length > 0) {
            vscode.window.showErrorMessage(
                `插入图片失败: ${errors[0]}${errors.length > 1 ? `（共 ${errors.length} 个错误）` : ''}`
            );
        }
        return null;
    }

    const markdown = lines.join('\n');
    if (errors.length > 0) {
        vscode.window.showWarningMessage(`已插入 ${lines.length} 张，${errors.length} 张失败`);
    } else if (lines.length === 1) {
        vscode.window.showInformationMessage('已插入 1 张图片');
    } else {
        vscode.window.showInformationMessage(`已插入 ${lines.length} 张图片`);
    }

    return { markdown };
}

// 检查剪贴板是否有图片
async function checkClipboardHasImage(): Promise<boolean> {
    return new Promise((resolve) => {
        const { execFile } = require('child_process');
        const script = `
Add-Type -AssemblyName System.Windows.Forms
$image = [System.Windows.Forms.Clipboard]::GetImage()
if ($image -ne $null) { Write-Output 'HAS_IMAGE' } else { Write-Output 'NO_IMAGE' }
`;
        execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
            { encoding: 'utf8' },
            (error: Error | null, stdout: string) => {
                resolve(stdout.trim() === 'HAS_IMAGE');
            }
        );
    });
}

// 智能粘贴：检测剪贴板内容，有图片则保存图片，否则执行默认粘贴
async function smartPaste(editor: vscode.TextEditor) {
    const hasImage = await checkClipboardHasImage();
    if (hasImage) {
        await pasteImageFromClipboard(editor);
    } else {
        // 执行默认粘贴
        await vscode.commands.executeCommand('editor.action.clipboardPasteAction');
    }
}

// 粘贴图片并返回 Markdown 引用（用于 Webview）
async function pasteImageAndGetMarkdown(document: vscode.TextDocument): Promise<{markdown: string, imagePath: string} | null> {
    try {
        const docDir = path.dirname(document.uri.fsPath);
        const imagesDir = path.join(docDir, 'images');

        if (!fs.existsSync(imagesDir)) {
            fs.mkdirSync(imagesDir, { recursive: true });
        }

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const imageName = `image-${timestamp}.png`;
        const imagePath = path.join(imagesDir, imageName);

        const { execFile } = require('child_process');
        
        const script = `
Add-Type -AssemblyName System.Windows.Forms
$image = [System.Windows.Forms.Clipboard]::GetImage()
if ($image -ne $null) {
    $image.Save('${imagePath.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)
    Write-Output 'SUCCESS'
} else {
    Write-Output 'NO_IMAGE'
}
`;
        
        const result = await new Promise<string>((resolve, reject) => {
            execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], 
                { encoding: 'utf8' },
                (error: Error | null, stdout: string, stderr: string) => {
                    if (error) {
                        reject(new Error(stderr || error.message));
                        return;
                    }
                    resolve(stdout.trim());
                }
            );
        });

        if (result === 'NO_IMAGE') {
            vscode.window.showWarningMessage('剪贴板中没有图片');
            return null;
        }

        if (result === 'SUCCESS') {
            const relativePath = `images/${imageName}`;
            const imageMarkdown = `![image](${relativePath})`;
            vscode.window.showInformationMessage(`图片已保存到 ${relativePath}`);
            return { markdown: imageMarkdown, imagePath: imagePath };
        }

        return null;
    } catch (error) {
        vscode.window.showErrorMessage(`粘贴图片失败: ${(error as Error).message}`);
        return null;
    }
}

async function pasteImageFromClipboard(editor: vscode.TextEditor) {
    try {
        const document = editor.document;
        const docDir = path.dirname(document.uri.fsPath);
        const imagesDir = path.join(docDir, 'images');

        // 确保 images 目录存在
        if (!fs.existsSync(imagesDir)) {
            fs.mkdirSync(imagesDir, { recursive: true });
        }

        // 生成唯一的文件名
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const imageName = `image-${timestamp}.png`;
        const imagePath = path.join(imagesDir, imageName);

        // 使用 PowerShell 从剪贴板获取图片并保存
        const { execFile } = require('child_process');
        
        const script = `
Add-Type -AssemblyName System.Windows.Forms
$image = [System.Windows.Forms.Clipboard]::GetImage()
if ($image -ne $null) {
    $image.Save('${imagePath.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)
    Write-Output 'SUCCESS'
} else {
    Write-Output 'NO_IMAGE'
}
`;
        
        await new Promise<void>((resolve, reject) => {
            execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], 
                { encoding: 'utf8' },
                (error: Error | null, stdout: string, stderr: string) => {
                    if (error) {
                        reject(new Error(stderr || error.message));
                        return;
                    }
                    if (stdout.trim() === 'NO_IMAGE') {
                        vscode.window.showWarningMessage('剪贴板中没有图片');
                        reject(new Error('No image in clipboard'));
                        return;
                    }
                    if (stdout.trim() === 'SUCCESS') {
                        resolve();
                    } else {
                        reject(new Error(stderr || 'Unknown error'));
                    }
                }
            );
        });

        // 插入 Markdown 图片引用
        const relativePath = `images/${imageName}`;
        const imageMarkdown = `![image](${relativePath})`;
        
        await editor.edit(editBuilder => {
            editBuilder.insert(editor.selection.active, imageMarkdown);
        });

        vscode.window.showInformationMessage(`图片已保存到 ${relativePath}`);

        // 刷新预览
        if (currentPanel) {
            updatePreview(document, currentPanel);
        }

    } catch (error) {
        if ((error as Error).message !== 'No image in clipboard') {
            vscode.window.showErrorMessage(`粘贴图片失败: ${(error as Error).message}`);
        }
    }
}

export function deactivate() {}
