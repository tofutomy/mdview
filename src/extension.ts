/**
 * Markdown Preview Outline — VS Code 扩展
 *
 * 通过 markdown-it 插件机制，在 VS Code 内置 Markdown 预览渲染时
 * 收集标题数据并嵌入 HTML，供预览中的 JS 脚本读取后渲染大纲侧栏。
 *
 * 数据流：
 *   markdown-it render → 遍历 token → 收集 {level, text, id, line}
 *                     → 注入 <div data-outline="json"> 到 HTML 开头
 *   preview.js 在预览 webview 中读取 → 渲染大纲面板
 */

import * as vscode from 'vscode';

/**
 * 将文本转为合法的 HTML ID 片段。
 * 保留中文字符（\u4e00-\u9fff），其他非单词字符替换为连字符。
 * 空文本时返回 'heading' 作为兜底。
 */
function slugify(text: string): string {
    return text
        .toLowerCase()
        .replace(/[^\w\u4e00-\u9fff]+/g, '-')
        .replace(/^-+|-+$/g, '')
        || 'heading';
}

/**
 * 从 markdown-it 的 inline token 中递归提取纯文本。
 *
 * markdown-it 解析标题 "## Hello **World**" 时：
 *   heading_open → inline → [ text "Hello ", strong_open, text "World", strong_close ]
 * 本函数递归遍历 children，只提取 text 类型 token 的 content。
 *
 * @param token markdown-it inline token
 * @returns 纯文本字符串
 */
function extractInlineText(token: any): string {
    if (!token) { return ''; }
    if (token.type === 'text') { return token.content || ''; }
    if (token.children && token.children.length > 0) {
        return token.children.map((t: any) => extractInlineText(t)).join('');
    }
    return token.content || '';
}

/**
 * 转义 HTML 属性值中的特殊字符。
 * 用于将 JSON 字符串安全放入 data-outline 属性。
 */
function escapeAttr(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/**
 * 扩展激活：返回 { extendMarkdownIt } 对象。
 * VS Code 检测到 markdown.markdownItPlugins: true 后，
 * 在渲染内置预览时调用此函数，传入 markdown-it 实例。
 */
export function activate(_context: vscode.ExtensionContext) {
    return {
        /**
         * VS Code 调用此方法来扩展 markdown-it 渲染器。
         * 我们包装 md.renderer.render，在每次渲染时：
         *   1. 遍历所有 token 收集标题信息
         *   2. 为标题元素设置 id 和 data-mdv-line 属性
         *   3. 在渲染输出的 HTML 开头注入隐藏的 data-outline 元素
         *
         * @param md markdown-it 实例
         * @returns 修改后的 markdown-it 实例
         */
        extendMarkdownIt(md: any) {
            // 保存原始渲染方法
            const render = md.renderer.render.bind(md.renderer);

            // 替换为我们的包装版本
            md.renderer.render = function (tokens: any[], options: any, env: any) {
                // 收集到的标题数据，最终序列化为 JSON 嵌入 HTML
                const headings: { level: number; text: string; id: string; line: number }[] = [];
                // 追踪已用 ID，确保唯一性
                const seenIds = new Set<string>();

                // 遍历 token 流，寻找 heading_open token
                for (let i = 0; i < tokens.length; i++) {
                    const token = tokens[i];
                    if (token.type !== 'heading_open') { continue; }

                    // 提取标题级别（h1 → 1, h2 → 2, ...）
                    const level = parseInt(token.tag.slice(1), 10);
                    if (isNaN(level)) { continue; }

                    // heading_open 的下一个 token 是 inline（标题文本）
                    const inlineToken = tokens[i + 1];
                    const text = extractInlineText(inlineToken);
                    if (!text) { continue; }

                    // token.map[0] 是标题在源文件中的行号（0-based）
                    // 设置自定义属性 data-mdv-line，用于预览中的 JS 导航定位
                    const line = (token.map && token.map[0]) ? token.map[0] : i;
                    try { token.attrSet('data-mdv-line', String(line)); } catch (_e) { /* ignore */ }

                    // 获取或生成 heading ID
                    // VS Code 可能已通过内置锚点插件设置了 id，优先使用
                    let id = '';
                    try { id = token.attrGet('id') || ''; } catch (_e) { /* ignore */ }
                    if (!id) {
                        // 生成唯一 ID：slugify 文本 + 冲突时追加数字后缀
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
                    headings.push({ level, text, id, line });
                }

                // 调用原始渲染方法生成 HTML
                const html = render(tokens, options, env);

                // 将标题数据序列化为 JSON，嵌入隐藏元素的 data-outline 属性
                // 这样预览中的 preview.js 可以通过 getElementById 读取
                const outlineJson = escapeAttr(JSON.stringify(headings));

                return '<div id="md-view-outline-data" style="display:none" data-outline="' + outlineJson + '"></div>\n' + html;
            };

            return md;
        }
    };
}

export function deactivate() { }
