import * as vscode from 'vscode';

interface OutlineItem {
    level: number;
    text: string;
    line: number;
    prefix: string;
    children: OutlineItem[];
}

interface OutlineData {
    outline: OutlineItem[];
    flatOutline: Omit<OutlineItem, 'children'>[];
    totalItems: number;
    filePath: string;
}

const LEVEL_INDICATORS = ['\u2460', '\u2461', '\u2462', '\u2463', '\u2464', '\u2465'];

function getLevelPrefix(level: number): string {
    const idx = Math.min(level, 6) - 1;
    return 'H' + level + LEVEL_INDICATORS[idx];
}

function parseOutline(content: string): { outline: OutlineItem[]; flatOutline: OutlineItem[] } {
    const lines = content.split('\n');
    const items: OutlineItem[] = [];
    let inCodeBlock = false;

    for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();

        if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
            inCodeBlock = !inCodeBlock;
            continue;
        }
        if (inCodeBlock) {continue;}
        if (lines[i].startsWith('    ') || lines[i].startsWith('\t')) {continue;}

        const match = trimmed.match(/^(#{1,6})\s+(.+)$/);
        if (!match) {continue;}

        const level = match[1].length;
        const text = match[2].trim();
        if (!text) {continue;}

        items.push({
            level,
            text,
            line: i,
            prefix: getLevelPrefix(level),
            children: []
        });
    }

    const tree = buildHierarchy(items);
    return { outline: tree, flatOutline: items };
}

function buildHierarchy(items: OutlineItem[]): OutlineItem[] {
    if (items.length === 0) {return [];}

    const roots: OutlineItem[] = [];
    const stack: OutlineItem[] = [];

    for (const item of items) {
        while (stack.length > 0 && stack[stack.length - 1].level >= item.level) {
            stack.pop();
        }

        if (stack.length > 0) {
            stack[stack.length - 1].children.push(item);
        } else {
            roots.push(item);
        }

        stack.push(item);
    }

    return roots;
}

class MarkdownOutlineProvider implements vscode.WebviewViewProvider, vscode.Disposable {
    public static readonly viewType = 'mdViewOutline';

    private _view?: vscode.WebviewView;
    private _sourceDoc?: vscode.TextDocument;
    private _disposables: vscode.Disposable[] = [];
    private _debounceTimer?: ReturnType<typeof setTimeout>;
    private _scrollDebounceTimer?: ReturnType<typeof setTimeout>;

    constructor(private readonly _context: vscode.ExtensionContext) { }

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._context.extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(
            (message) => {
                switch (message.command) {
                    case 'jumpToLine':
                        this._jumpToLine(message.line);
                        break;
                    case 'refresh':
                        this.refresh();
                        break;
                    case 'ready':
                        if (this._sourceDoc) {
                            this.refresh();
                        }
                        break;
                }
            },
            undefined,
            this._disposables
        );

        if (this._sourceDoc) {
            this.refresh();
        }
    }

    setSourceDoc(doc: vscode.TextDocument | undefined): void {
        this._sourceDoc = doc;
    }

    onDocClosed(doc: vscode.TextDocument): void {
        if (this._sourceDoc === doc) {
            this._sourceDoc = undefined;
            this.clearOutline();
        }
    }

    onDocChanged(doc: vscode.TextDocument): void {
        if (!this._sourceDoc) {
            this._sourceDoc = doc;
        }
        if (this._sourceDoc === doc) {
            this.debounceRefresh();
        }
    }

    refresh(): void {
        if (!this._sourceDoc || !this._view) {return;}
        const result = parseOutline(this._sourceDoc.getText());
        const data: OutlineData = {
            outline: result.outline,
            flatOutline: result.flatOutline.map(({ children: _c, ...rest }) => rest),
            totalItems: result.flatOutline.length,
            filePath: this._sourceDoc.uri.fsPath
        };
        this._view.webview.postMessage({ command: 'updateOutline', data });
    }

    debounceRefresh(): void {
        if (this._debounceTimer) {clearTimeout(this._debounceTimer);}
        this._debounceTimer = setTimeout(() => this.refresh(), 150);
    }

    clearOutline(): void {
        if (this._view) {
            this._view.webview.postMessage({ command: 'clearOutline' });
        }
    }

    updatePosition(line: number): void {
        if (!this._view || !this._sourceDoc) {return;}
        const result = parseOutline(this._sourceDoc.getText());
        const flatOutline = result.flatOutline.map(({ children: _c, ...rest }) => rest);
        const currentItem = this._findItemByLine(result.flatOutline, line);
        this._view.webview.postMessage({
            command: 'highlightCurrentLine',
            line,
            currentItem: currentItem ? { level: currentItem.level, text: currentItem.text, line: currentItem.line, prefix: currentItem.prefix } : null,
            flatOutline
        });
    }

    updateScrollPosition(line: number): void {
        if (!this._view || !this._sourceDoc) {return;}
        this._view.webview.postMessage({
            command: 'scrollToLine',
            line
        });
    }

    private _jumpToLine(line: number): void {
        const editor = vscode.window.activeTextEditor;
        if (!editor || !this._sourceDoc) {return;}
        if (editor.document !== this._sourceDoc) {
            vscode.window.showTextDocument(this._sourceDoc, { preserveFocus: false }).then((ed) => {
                const position = new vscode.Position(line, 0);
                ed.selection = new vscode.Selection(position, position);
                ed.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
            });
            return;
        }
        const position = new vscode.Position(line, 0);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
    }

    private _findItemByLine(items: OutlineItem[], targetLine: number): OutlineItem | null {
        let best: OutlineItem | null = null;
        for (const item of items) {
            if (item.line <= targetLine) {
                best = item;
            } else {
                break;
            }
        }
        return best;
    }

    private _getHtmlForWebview(webview: vscode.Webview): string {
        const styleUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._context.extensionUri, 'media', 'main.css')
        );
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._context.extensionUri, 'media', 'main.js')
        );

        const nonce = getNonce();

        return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link href="${styleUri}" rel="stylesheet">
    <title>Markdown \u5927\u7eb2</title>
</head>
<body>
    <div class="header">
        <span class="header-title">\u{1F4CB} Markdown \u5927\u7eb2</span>
    </div>

    <div class="content">
        <div id="loading" class="loading">\u89e3\u6790\u4e2d...</div>
        <div id="error" class="error hidden"></div>
        <div id="empty" class="empty hidden">\u8bf7\u6253\u5f00 Markdown \u6587\u4ef6</div>
        <div id="outline" class="outline hidden"></div>
    </div>

    <div class="footer">
        <div id="stats" class="stats">\u8bf7\u6253\u5f00 Markdown \u6587\u4ef6</div>
    </div>

    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }

    dispose(): void {
        if (this._debounceTimer) {clearTimeout(this._debounceTimer);}
        if (this._scrollDebounceTimer) {clearTimeout(this._scrollDebounceTimer);}
        this._disposables.forEach((d) => d.dispose());
        this._disposables = [];
    }
}

function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

export function activate(context: vscode.ExtensionContext): void {
    const provider = new MarkdownOutlineProvider(context);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(MarkdownOutlineProvider.viewType, provider)
    );

    context.subscriptions.push(provider);

    const refreshCommand = vscode.commands.registerCommand('md-view.refreshOutline', () => {
        provider.refresh();
    });
    context.subscriptions.push(refreshCommand);

    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor((editor) => {
            if (editor && editor.document.languageId === 'markdown') {
                provider.setSourceDoc(editor.document);
                provider.refresh();
            }
        })
    );

    context.subscriptions.push(
        vscode.workspace.onDidCloseTextDocument((doc) => {
            provider.onDocClosed(doc);
        })
    );

    context.subscriptions.push(
        vscode.workspace.onDidChangeTextDocument((event) => {
            if (event.document.languageId === 'markdown') {
                provider.onDocChanged(event.document);
            }
        })
    );

    context.subscriptions.push(
        vscode.window.onDidChangeTextEditorSelection((event) => {
            if (event.textEditor.document.languageId === 'markdown') {
                const line = event.selections[0].active.line;
                provider.setSourceDoc(event.textEditor.document);
                provider.updatePosition(line);
            }
        })
    );

    context.subscriptions.push(
        vscode.window.onDidChangeTextEditorVisibleRanges((event) => {
            if (event.textEditor.document.languageId === 'markdown') {
                if (event.visibleRanges.length > 0) {
                    const topLine = event.visibleRanges[0].start.line + 3;
                    provider.setSourceDoc(event.textEditor.document);
                    provider.updateScrollPosition(topLine);
                }
            }
        })
    );
}

export function deactivate(): void { }
