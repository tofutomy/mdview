# Markdown Preview Outline

在 VS Code 内置 Markdown 预览中显示标题大纲，支持层级折叠、双向跟随、点击跳转。

## 功能

- **预览内嵌大纲**：打开 Markdown 预览（`Ctrl+Shift+V` / `Ctrl+K V`），左侧自动显示大纲面板
- **层级树**：H1-H6 标题按层级缩进，可折叠展开
- **点击跳转**：点击大纲项，预览平滑滚动到对应标题
- **双向跟随**：滚动预览时大纲自动高亮当前可见标题；点击大纲高亮当前项
- **面板开关**：左上角 ☰ 按钮切换面板显隐，状态自动记忆

## 使用

1. 打开 `.md` 文件
2. `Ctrl+Shift+V` 打开内置预览
3. 左侧 ☰ 展开大纲面板，点击标题导航

## 快捷键

| 功能 | Windows/Linux | Mac |
|------|---------------|-----|
| 内置预览 | `Ctrl+Shift+V` | `Cmd+Shift+V` |
| 侧边预览 | `Ctrl+K V` | `Cmd+K V` |

## 技术实现

通过三个 VS Code 贡献点注入到内置预览：

- `markdown.markdownItPlugins` — 收集标题数据并嵌入 HTML
- `markdown.previewScripts` — 注入 JS 渲染大纲面板
- `markdown.previewStyles` — 注入 CSS 样式

## 开发

```bash
npm install
npm run compile   # 编译
npm run watch     # 监听模式
```

按 `F5` 启动调试。

## License

MIT
