import * as vscode from 'vscode';

function slugify(text: string): string {
    return text
        .toLowerCase()
        .replace(/[^\w\u4e00-\u9fff]+/g, '-')
        .replace(/^-+|-+$/g, '')
        || 'heading';
}

function extractInlineText(token: any): string {
    if (!token) { return ''; }
    if (token.type === 'text') { return token.content || ''; }
    if (token.children && token.children.length > 0) {
        return token.children.map((t: any) => extractInlineText(t)).join('');
    }
    return token.content || '';
}

function escapeAttr(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

export function activate(_context: vscode.ExtensionContext) {
    return {
        extendMarkdownIt(md: any) {
            const render = md.renderer.render.bind(md.renderer);

            md.renderer.render = function (tokens: any[], options: any, env: any) {
                const headings: { level: number; text: string; id: string }[] = [];
                const seenIds = new Set<string>();

                for (let i = 0; i < tokens.length; i++) {
                    const token = tokens[i];
                    if (token.type !== 'heading_open') { continue; }

                    const level = parseInt(token.tag.slice(1), 10);
                    if (isNaN(level)) { continue; }

                    const inlineToken = tokens[i + 1];
                    const text = extractInlineText(inlineToken);
                    if (!text) { continue; }

                    let id = '';
                    try { id = token.attrGet('id') || ''; } catch (_e) { /* ignore */ }
                    if (!id) {
                        id = slugify(text);
                        let suffix = 0;
                        let uniqueId = id;
                        while (seenIds.has(uniqueId)) {
                            suffix++;
                            uniqueId = id + '-' + suffix;
                        }
                        id = uniqueId;
                        try { token.attrSet('id', id); } catch (_e) { /* ignore */ }
                    }
                    seenIds.add(id);
                    headings.push({ level, text, id });
                }

                const html = render(tokens, options, env);
                const outlineJson = escapeAttr(JSON.stringify(headings));

                return '<div id="md-view-outline-data" style="display:none" data-outline="' + outlineJson + '"></div>\n' + html;
            };

            return md;
        }
    };
}

export function deactivate() { }
