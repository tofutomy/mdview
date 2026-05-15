/* =====================================================================
 * Markdown Preview Outline — 预览内大纲面板
 *
 * 本文件由 VS Code 通过 markdown.previewScripts 注入到内置 Markdown
 * 预览的 webview 中运行。与预览内容共享同一个 DOM。
 *
 * 核心流程：
 *   DOMContentLoaded → init()
 *     ├── loadState()          从 localStorage 恢复折叠/可见状态
 *     ├── ensurePanel()        创建/恢复左侧大纲面板 DOM
 *     ├── processOutline()     读取 #md-view-outline-data，渲染大纲树
 *     └── 注册 vscode.markdown.updateContent 事件监听
 *
 *   vscode.markdown.updateContent → ensurePanel() + processOutline()
 *     VS Code 替换预览内容时触发，重建面板并重新渲染大纲。
 *
 *   用户滚动预览 → window scroll 事件 → updateScrollActive()
 *     根据当前视口位置，在大纲中淡色高亮最近的标题。
 *
 *   用户点击大纲项 → scrollToHeading(line)
 *     通过 data-mdv-line 属性找到预览中对应的标题元素并滚动。
 * ===================================================================== */

(function () {
    'use strict';

    // ====================== 常量 ======================

    /** 标题等级前缀显示：H1①, H2②, H3③, ... */
    var LEVEL_PREFIXES = ['H1\u2460', 'H2\u2461', 'H3\u2462', 'H4\u2463', 'H5\u2464', 'H6\u2465'];

    /** localStorage 键：折叠状态 */
    var COLLAPSED_KEY = 'md-view-collapsed';
    /** localStorage 键：面板可见性 */
    var PANEL_VISIBLE_KEY = 'md-view-panel-visible';

    // ====================== 全局状态 ======================

    /** 已折叠的标题 ID 集合，key 为标题 id，value 为 true */
    var collapsedItems = {};

    /** 大纲面板是否可见 */
    var panelVisible = true;

    /** 当前大纲数据：{ outline: 层级树, flat: 扁平数组 }，null 表示无数据 */
    var currentOutline = null;

    /** 当前光标激活的行号（用户点击大纲项时设置），-1 表示无 */
    var activeLine = -1;

    /** 当前滚动跟随激活的行号（预览滚动时自动设置），-1 表示无 */
    var scrollActiveLine = -1;

    /** 滚动防抖定时器 */
    var scrollTimer = null;

    /** 防止重复初始化的标志 */
    var initRun = false;

    // ====================== 初始化入口 ======================

    /**
     * 初始化入口：恢复状态 → 建面板 → 渲染大纲 → 注册事件监听。
     * 通过 initRun 标志确保只执行一次（markdown.previewScripts 可能被多次加载）。
     */
    function init() {
        if (initRun) { return; }
        initRun = true;

        loadState();
        ensurePanel();
        processOutline();

        // VS Code 内置预览在内容更新（切换文档、编辑源文件）时触发此事件
        // 此时 body 内的预览内容可能被整体替换，面板 DOM 也会被销毁
        window.addEventListener('vscode.markdown.updateContent', function () {
            ensurePanel();      // 重建面板（如果在内容替换时被销毁）
            processOutline();   // 重新读取数据并渲染大纲
        });

        // 监听页面滚动，实时更新大纲中的淡色高亮
        // 使用 window 而非 document/body，因为 body 可能被 replaceContent 替换
        window.addEventListener('scroll', function () {
            if (scrollTimer) { clearTimeout(scrollTimer); }
            scrollTimer = setTimeout(updateScrollActive, 100);
        }, { passive: true });
    }

    // ====================== 状态持久化（localStorage） ======================

    /**
     * 从 localStorage 恢复折叠状态和面板可见性。
     * 异常时回退到默认值。
     */
    function loadState() {
        try {
            var c = JSON.parse(localStorage.getItem(COLLAPSED_KEY) || '{}');
            if (c && typeof c === 'object') { collapsedItems = c; }
        } catch (e) { collapsedItems = {}; }
        try {
            panelVisible = localStorage.getItem(PANEL_VISIBLE_KEY) !== 'false';
        } catch (e) { panelVisible = true; }
    }

    /** 持久化折叠状态 */
    function saveCollapsed() {
        try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify(collapsedItems)); } catch (e) { /* ignore */ }
    }

    /** 持久化面板可见性 */
    function savePanelVisible() {
        try { localStorage.setItem(PANEL_VISIBLE_KEY, String(panelVisible)); } catch (e) { /* ignore */ }
    }

    // ====================== 面板 DOM 管理 ======================

    /**
     * 确保大纲面板 DOM 元素存在且引用最新。
     *
     * 为什么需要这个函数：
     * - 初始化时首次创建面板
     * - vscode.markdown.updateContent 后 VS Code 可能整体替换 body 内容，
     *   导致之前创建的面板元素被销毁。此时需要重新创建。
     *
     * 面板结构：
     *   #md-view-outline-panel (fixed, 左侧 220px)
     *     ├── .md-view-panel-header → "📋 Outline"
     *     ├── .md-view-panel-content
     *     │   └── #md-view-outline-tree (大纲树容器)
     *     └── #md-view-outline-footer (统计信息)
     *   #md-view-outline-toggle (☰ 按钮, fixed)
     */
    function ensurePanel() {
        var panel = document.getElementById('md-view-outline-panel');
        var toggle = document.getElementById('md-view-outline-toggle');

        // 如果面板已存在（首次加载或未被销毁），只需刷新 CSS 状态
        if (panel && toggle) {
            panel = document.getElementById('md-view-outline-panel');
            toggle = document.getElementById('md-view-outline-toggle');
            applyPanelState(panel, toggle);
            return;
        }

        // ---- 创建 ☰ 开关按钮 ----
        toggle = document.createElement('button');
        toggle.id = 'md-view-outline-toggle';
        toggle.title = 'Toggle Outline';
        toggle.textContent = '\u2630'; // ☰

        // ---- 创建大纲面板 ----
        panel = document.createElement('div');
        panel.id = 'md-view-outline-panel';

        // 标题栏
        var header = document.createElement('div');
        header.className = 'md-view-panel-header';
        var title = document.createElement('span');
        title.className = 'md-view-panel-title';
        title.textContent = '\u{1F4CB} Outline'; // 📋
        header.appendChild(title);

        // 大纲树容器（可滚动）
        var content = document.createElement('div');
        content.className = 'md-view-panel-content';
        var tree = document.createElement('div');
        tree.className = 'md-view-tree';
        tree.id = 'md-view-outline-tree';
        content.appendChild(tree);

        // 底部统计信息
        var footer = document.createElement('div');
        footer.className = 'md-view-footer';
        footer.id = 'md-view-outline-footer';
        footer.textContent = '';

        panel.appendChild(header);
        panel.appendChild(content);
        panel.appendChild(footer);

        document.body.appendChild(panel);
        document.body.appendChild(toggle);

        // ☰ 按钮点击事件
        toggle.addEventListener('click', function (e) {
            e.stopPropagation();
            togglePanel();
        });

        applyPanelState(panel, toggle);
    }

    /**
     * 根据 panelVisible 状态设置面板和按钮的 CSS 类及 body 样式。
     * 面板通过 CSS transform 滑入/滑出，body 通过 margin-left 为面板留出空间。
     */
    function applyPanelState(panel, toggle) {
        if (panelVisible) {
            panel.classList.add('visible');
            toggle.classList.add('open');
            toggle.title = 'Hide Outline';
            document.body.classList.add('md-view-outline-open');
        } else {
            panel.classList.remove('visible');
            toggle.classList.remove('open');
            toggle.title = 'Show Outline';
            document.body.classList.remove('md-view-outline-open');
        }
    }

    /** 切换面板可见性 */
    function togglePanel() {
        panelVisible = !panelVisible;
        var panel = document.getElementById('md-view-outline-panel');
        var toggle = document.getElementById('md-view-outline-toggle');
        if (panel && toggle) { applyPanelState(panel, toggle); }
        savePanelVisible();
    }

    // ====================== 大纲数据读取与渲染 ======================

    /**
     * 从 DOM 中读取大纲数据并触发渲染。
     * 如果数据元素尚不在 DOM 中（内容刚被替换），延迟 60ms 重试一次。
     */
    function processOutline() {
        var dataEl = document.getElementById('md-view-outline-data');
        if (!dataEl) {
            // data-outline 元素由 markdown-it 插件注入到 HTML 开头，
            // 在 vscode.markdown.updateContent 后可能尚未插入 DOM
            setTimeout(function () {
                var retryEl = document.getElementById('md-view-outline-data');
                if (retryEl) { doRender(retryEl); }
            }, 60);
            return;
        }
        doRender(dataEl);
    }

    /**
     * 解析 data-outline JSON，构建层级树，渲染到大纲面板。
     * @param dataEl 包含 data-outline 属性的隐藏 DOM 元素
     */
    function doRender(dataEl) {
        var raw = dataEl.getAttribute('data-outline');
        if (!raw) { clearOutline(); return; }

        var items;
        try { items = JSON.parse(raw); } catch (e) { clearOutline(); return; }

        var tree = document.getElementById('md-view-outline-tree');
        var footer = document.getElementById('md-view-outline-footer');
        if (!tree) { return; }

        // 无标题时显示空状态
        if (!items || items.length === 0) {
            tree.innerHTML = '<div style="padding:12px;color:var(--vscode-descriptionForeground);font-size:11px;">\u6ca1\u6709\u6807\u9898</div>'; // 没有标题
            if (footer) { footer.textContent = '0 \u4e2a\u6807\u9898'; } // 0 个标题
            currentOutline = null;
            activeLine = -1;
            scrollActiveLine = -1;
            return;
        }

        // 为每个标题项分配等级前缀（H1① - H6⑥）
        items.forEach(function (item) {
            var idx = Math.min(item.level, 6) - 1;
            item.prefix = LEVEL_PREFIXES[idx];
        });

        // 从扁平列表构建层级树
        var outlineTree = buildTree(items);
        currentOutline = { outline: outlineTree, flat: items };
        renderTree(outlineTree, tree);
        if (footer) { footer.textContent = items.length + ' \u4e2a\u6807\u9898'; } // N 个标题

        // 重置激活状态，稍后根据滚动位置更新
        activeLine = -1;
        scrollActiveLine = -1;
        setTimeout(updateScrollActive, 200);
    }

    /** 清空大纲面板 */
    function clearOutline() {
        var tree = document.getElementById('md-view-outline-tree');
        var footer = document.getElementById('md-view-outline-footer');
        if (tree) { tree.innerHTML = ''; }
        if (footer) { footer.textContent = '\u8bf7\u6253\u5f00 Markdown \u6587\u4ef6'; } // 请打开 Markdown 文件
        currentOutline = null;
        activeLine = -1;
        scrollActiveLine = -1;
    }

    // ====================== 层级树构建 ======================

    /**
     * 将扁平的标题列表构建为层级树结构。
     *
     * 算法：使用栈维护当前层级的父节点链。
     * 遍历每个标题时，弹出栈中 level >= 当前 item.level 的节点，
     * 栈顶即为当前标题的父节点。栈为空则表示是根节点。
     *
     * 示例：H1, H2, H3, H2, H1
     *   遍历过程：H1→root, H2→H1.children, H3→H2.children,
     *            H2→pop(H3,H2)→H1.children, H1→pop→root
     *
     * @param items 按出现顺序排列的扁平标题列表
     * @returns 层级树根节点数组
     */
    function buildTree(items) {
        if (items.length === 0) { return []; }
        var roots = [];
        var stack = []; // 当前路径上的父节点栈

        for (var i = 0; i < items.length; i++) {
            var item = items[i];

            // 弹出所有层级不小于当前项的父节点
            // 例：当前 H2，之前栈中有 H2 或 H3 → 它们不再是父节点
            while (stack.length > 0 && stack[stack.length - 1].level >= item.level) {
                stack.pop();
            }

            if (stack.length > 0) {
                // 有父节点 → 添加到父节点的 children
                if (!stack[stack.length - 1].children) { stack[stack.length - 1].children = []; }
                stack[stack.length - 1].children.push(item);
            } else {
                // 无父节点 → 根节点
                roots.push(item);
            }

            // 当前项入栈，可能成为后续标题的父节点
            stack.push(item);
        }
        return roots;
    }

    // ====================== 大纲树 DOM 渲染 ======================

    /**
     * 将层级树渲染到指定的 DOM 容器中。
     * 使用 cloneNode + replaceChild 技巧清除旧的点击事件监听器。
     *
     * @param items 层级树根节点数组
     * @param tree 大纲树容器 DOM 元素
     */
    function renderTree(items, tree) {
        tree.innerHTML = items.map(function (item) { return renderItem(item); }).join('');
        // 克隆替换以移除旧的事件监听器，避免内存泄漏和重复触发
        var newTree = tree.cloneNode(true);
        tree.parentNode.replaceChild(newTree, tree);
        newTree.addEventListener('click', handleTreeClick);
    }

    /**
     * 渲染单个大纲项的 HTML 字符串（递归渲染子节点）。
     *
     * DOM 结构：
     * <div class="md-view-item">
     *   <div class="md-view-item-row" data-line="{行号}">
     *     <span class="md-view-toggle" data-action="toggle" data-id="{标题ID}"></span>
     *     <span class="md-view-badge lv{等级}">H1①</span>
     *     <span class="md-view-text">{标题文本}</span>
     *   </div>
     *   <div class="md-view-children">...</div>  <!-- 子节点 -->
     * </div>
     *
     * @param item 大纲项（含 children）
     * @returns HTML 字符串
     */
    function renderItem(item) {
        var hasChildren = item.children && item.children.length > 0;
        var collapsed = collapsedItems[item.id] === true;

        var html = '<div class="md-view-item">';
        // 行元素：data-line 用于导航定位，对应扩展端设置的 data-mdv-line
        html += '<div class="md-view-item-row" data-line="' + item.line + '">';
        // 折叠箭头：data-action="toggle" 与 data-id 供 handleTreeClick 识别
        html += '<span class="md-view-toggle ' + (hasChildren ? '' : 'leaf') + '" data-action="toggle" data-id="' + escAttr(item.id) + '">' + (hasChildren ? (collapsed ? '\u25B6' : '\u25BC') : '') + '</span>';
        // 等级徽章
        html += '<span class="md-view-badge lv' + item.level + '">' + escHtml(item.prefix) + '</span>';
        // 标题文本
        html += '<span class="md-view-text">' + escHtml(item.text) + '</span>';
        html += '</div>';

        // 子节点列表（折叠时添加 .hidden 类）
        if (hasChildren) {
            html += '<div class="md-view-children' + (collapsed ? ' hidden' : '') + '">';
            html += item.children.map(function (child) { return renderItem(child); }).join('');
            html += '</div>';
        }

        html += '</div>';
        return html;
    }

    // ====================== 用户交互处理 ======================

    /**
     * 大纲树上的点击事件处理（事件委托）。
     *
     * 两种点击场景：
     *   1. 点击折叠箭头（data-action="toggle"）→ 折叠/展开子节点
     *   2. 点击行其他区域 → 导航到对应标题
     */
    function handleTreeClick(e) {
        var target = e.target;

        // 判断是否点击了折叠箭头
        var action = target.getAttribute('data-action');
        var id = target.getAttribute('data-id');
        if (action === 'toggle') {
            e.stopPropagation();
            toggleCollapse(id);
            return;
        }

        // 查找最近的 .md-view-item-row 祖先
        var row = target.closest('.md-view-item-row');
        if (row) {
            var line = parseInt(row.getAttribute('data-line'), 10);
            if (!isNaN(line)) {
                scrollToHeading(line);  // 预览内跳转
                setActive(line);       // 高亮当前项
            }
        }
    }

    /**
     * 折叠/展开指定标题的子节点，持久化状态，刷新渲染。
     * @param id 标题 ID
     */
    function toggleCollapse(id) {
        collapsedItems[id] = !collapsedItems[id];
        saveCollapsed();

        // 重新渲染整个树以更新折叠状态
        if (currentOutline && currentOutline.outline) {
            var tree = document.getElementById('md-view-outline-tree');
            if (tree) {
                renderTree(currentOutline.outline, tree);
                // 恢复之前的高亮状态
                if (activeLine >= 0) {
                    var row = document.querySelector('#md-view-outline-tree .md-view-item-row[data-line="' + activeLine + '"]');
                    if (row) { row.classList.add('active'); }
                }
                if (scrollActiveLine >= 0) {
                    var sr = document.querySelector('#md-view-outline-tree .md-view-item-row[data-line="' + scrollActiveLine + '"]');
                    if (sr) { sr.classList.add('scroll-active'); }
                }
            }
        }
    }

    // ====================== 预览内导航 ======================

    /**
     * 在预览内容中滚动到指定行号对应的标题。
     *
     * 定位方式：通过 data-mdv-line 自定义属性（由 markdown-it 插件在渲染时设置）
     * 查找标题元素。不用 getElementById 是因为 VS Code 内置预览可能覆写 heading id。
     *
     * @param line 源文件行号（0-based）
     */
    function scrollToHeading(line) {
        var el = document.querySelector('[data-mdv-line="' + line + '"]');
        if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    }

    /**
     * 设置大纲项为"光标激活"状态（蓝色高亮）。
     * 同时清除滚动跟随的淡色高亮（光标激活优先级更高）。
     *
     * @param line 源文件行号
     */
    function setActive(line) {
        if (activeLine === line) { return; }

        var tree = document.getElementById('md-view-outline-tree');
        if (!tree) { return; }

        // 移除旧的光标激活
        if (activeLine >= 0) {
            var old = tree.querySelector('.md-view-item-row[data-line="' + activeLine + '"]');
            if (old) { old.classList.remove('active'); }
        }
        activeLine = line;
        scrollActiveLine = -1; // 光标激活时清除滚动激活

        // 设置新的光标激活
        var row = tree.querySelector('.md-view-item-row[data-line="' + line + '"]');
        if (row) {
            row.classList.remove('scroll-active');
            row.classList.add('active');
            row.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); // 确保大纲项可见
        }
    }

    // ====================== 滚动跟随（预览滚动 → 大纲高亮） ======================

    /**
     * 根据当前预览的滚动位置，在大纲中淡色高亮最近的可见标题。
     * 视口 30% 处作为参考线，找该位置之上最近的标题。
     *
     * 双激活机制：
     *   - 光标激活（active）：用户点击大纲项，蓝色强高亮，优先级高
     *   - 滚动激活（scroll-active）：预览滚动触发，灰色淡高亮，优先级低
     *   光标激活存在时，滚动激活不生效
     */
    function updateScrollActive() {
        if (!currentOutline || !currentOutline.flat) { return; }

        var headings = currentOutline.flat;
        // 使用 window.scrollY 作为滚动位置（VS Code 预览的滚动容器是 window）
        var viewportTop = window.scrollY || document.documentElement.scrollTop || 0;
        // 参考线：视口 30% 处（偏上，符合阅读习惯）
        var viewportMid = viewportTop + window.innerHeight * 0.3;
        var closest = null;
        var closestDist = Infinity;

        // 遍历所有标题，找到参考线之上最近的标题
        for (var i = 0; i < headings.length; i++) {
            var el = document.querySelector('[data-mdv-line="' + headings[i].line + '"]');
            if (!el) { continue; }
            var rect = el.getBoundingClientRect();
            var top = rect.top + viewportTop; // 转为页面绝对坐标
            if (top <= viewportMid) {
                var dist = viewportMid - top;
                if (dist < closestDist) {
                    closestDist = dist;
                    closest = headings[i];
                }
            }
        }

        if (!closest) { return; }

        // 如果和光标激活的是同一个标题，清除滚动激活（不用重复标记）
        if (closest.line === activeLine) {
            if (scrollActiveLine >= 0) {
                var sr = document.querySelector('#md-view-outline-tree .md-view-item-row[data-line="' + scrollActiveLine + '"]');
                if (sr) { sr.classList.remove('scroll-active'); }
                scrollActiveLine = -1;
            }
            return;
        }

        // 如果滚动激活的标题没变，跳过
        if (scrollActiveLine === closest.line) { return; }

        var tree = document.getElementById('md-view-outline-tree');
        if (!tree) { return; }

        // 移除旧的滚动激活
        if (scrollActiveLine >= 0) {
            var old = tree.querySelector('.md-view-item-row[data-line="' + scrollActiveLine + '"]');
            if (old) { old.classList.remove('scroll-active'); }
        }

        // 设置新的滚动激活（前提是该行不是光标激活状态）
        scrollActiveLine = closest.line;
        var row = tree.querySelector('.md-view-item-row[data-line="' + closest.line + '"]');
        if (row && !row.classList.contains('active')) {
            row.classList.add('scroll-active');
        }
    }

    // ====================== 转义工具函数 ======================

    /**
     * HTML 文本转义：防止 XSS，用于 .textContent 替代方案。
     * 注意：renderItem 使用 innerHTML，必须转义用户提供的文本。
     */
    function escHtml(text) {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    /**
     * HTML 属性值转义：用于 data-* 属性中的值。
     * 属性值用双引号包裹，所以 " 必须转义。
     */
    function escAttr(text) {
        return text
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    // ====================== 启动 ======================

    // 根据文档加载状态选择合适的时机初始化
    // markdown.previewScripts 可能在 DOMContentLoaded 之前或之后执行
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
