# Change Log

All notable changes to the "md-view" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

## [0.0.7]

- 支持从本机选择图片插入：命令「MD View: 插入图片」与预览工具栏「插入图片」；文件复制到文档同级 `images` 并插入 Markdown 引用。
- 若所选文件已在该文档的 `images` 目录下（含子目录），则不再复制，仅插入引用。
- 支持在文件对话框中一次多选多张图片，按选择顺序每张一行插入。

## [0.0.6]

- 优化编辑区与预览区的双向滚动同步，减少跟随定位时的抖动。
