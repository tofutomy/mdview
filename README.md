# MD View - Markdown 预览插件

一个 VS Code Markdown 预览插件，支持目录导航和图片粘贴功能。

## ✨ 功能特性

### 1. Markdown 预览带目录导航
- 打开 Markdown 文件后，可以直接查看渲染后的内容
- 左侧显示文档目录（TOC），自动提取所有标题
- 点击目录项可以快速定位到对应位置
- 实时同步：编辑文档时预览自动更新

### 2. 图片粘贴功能
- 支持从剪贴板直接粘贴图片
- 自动在文档同级目录创建 `images` 文件夹
- 图片自动保存并生成 Markdown 引用
- 预览中可直接浏览本地图片

## 🚀 使用方法

### 打开预览
- **快捷键**: `Ctrl+Shift+V` (Mac: `Cmd+Shift+V`)
- **命令面板**: 输入 "MD View: 打开预览"
- **编辑器标题栏**: 点击预览图标

### 粘贴图片
1. 复制图片到剪贴板（截图或复制图片文件）
2. 在 Markdown 编辑器中：
   - **快捷键**: `Ctrl+Alt+V` (Mac: `Cmd+Alt+V`)
   - **右键菜单**: 选择 "MD View: 粘贴图片"
3. 图片将自动保存到 `images` 目录并插入引用

## 📁 目录结构

粘贴图片后，会自动创建以下结构：

```
your-document.md
images/
  ├── image-2026-01-26T10-30-00-000Z.png
  ├── image-2026-01-26T10-35-00-000Z.png
  └── ...
```

## ⌨️ 快捷键

| 功能 | Windows/Linux | Mac |
|------|---------------|-----|
| 打开预览 | `Ctrl+Shift+V` | `Cmd+Shift+V` |
| 粘贴图片 | `Ctrl+Alt+V` | `Cmd+Alt+V` |

## 🔧 开发

```bash
# 安装依赖
npm install

# 编译
npm run compile

# 监听模式
npm run watch
```

按 `F5` 启动调试，将打开一个新的 VS Code 窗口来测试插件。

## 📝 License

MIT
