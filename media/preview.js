(function () {
    'use strict';

    var LEVEL_PREFIXES = ['H1\u2460', 'H2\u2461', 'H3\u2462', 'H4\u2463', 'H5\u2464', 'H6\u2465'];
    var COLLAPSED_KEY = 'md-view-collapsed';
    var PANEL_VISIBLE_KEY = 'md-view-panel-visible';

    var collapsedItems = {};
    var panelVisible = true;
    var currentOutline = null;
    var activeId = null;
    var scrollActiveId = null;
    var scrollTimer = null;
    var initRun = false;

    function init() {
        if (initRun) { return; }
        initRun = true;

        loadState();
        ensurePanel();
        processOutline();

        window.addEventListener('vscode.markdown.updateContent', function () {
            // VS Code may replace body content, invalidating our DOM references
            ensurePanel();
            processOutline();
        });

        // Use window scroll (not replaced on content update)
        window.addEventListener('scroll', function () {
            if (scrollTimer) { clearTimeout(scrollTimer); }
            scrollTimer = setTimeout(updateScrollActive, 100);
        }, { passive: true });
    }

    function loadState() {
        try {
            var c = JSON.parse(localStorage.getItem(COLLAPSED_KEY) || '{}');
            if (c && typeof c === 'object') { collapsedItems = c; }
        } catch (e) { collapsedItems = {}; }
        try {
            panelVisible = localStorage.getItem(PANEL_VISIBLE_KEY) !== 'false';
        } catch (e) { panelVisible = true; }
    }

    function saveCollapsed() {
        try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify(collapsedItems)); } catch (e) { /* ignore */ }
    }

    function savePanelVisible() {
        try { localStorage.setItem(PANEL_VISIBLE_KEY, String(panelVisible)); } catch (e) { /* ignore */ }
    }

    /* Ensure panel elements exist in DOM. After vscode.markdown.updateContent,
       body may have been replaced, so we must re-create if missing. */
    function ensurePanel() {
        // Check if panel exists in current DOM
        var panel = document.getElementById('md-view-outline-panel');
        var toggle = document.getElementById('md-view-outline-toggle');

        if (panel && toggle) {
            // Refresh local refs (elements may be new instances)
            panel = document.getElementById('md-view-outline-panel');
            toggle = document.getElementById('md-view-outline-toggle');
            applyPanelState(panel, toggle);
            return;
        }

        // Create toggle button
        toggle = document.createElement('button');
        toggle.id = 'md-view-outline-toggle';
        toggle.title = 'Toggle Outline';
        toggle.textContent = '\u2630';

        // Create panel
        panel = document.createElement('div');
        panel.id = 'md-view-outline-panel';

        var header = document.createElement('div');
        header.className = 'md-view-panel-header';
        var title = document.createElement('span');
        title.className = 'md-view-panel-title';
        title.textContent = '\u{1F4CB} Outline';
        header.appendChild(title);

        var content = document.createElement('div');
        content.className = 'md-view-panel-content';

        var tree = document.createElement('div');
        tree.className = 'md-view-tree';
        tree.id = 'md-view-outline-tree';
        content.appendChild(tree);

        var footer = document.createElement('div');
        footer.className = 'md-view-footer';
        footer.id = 'md-view-outline-footer';
        footer.textContent = '';

        panel.appendChild(header);
        panel.appendChild(content);
        panel.appendChild(footer);

        document.body.appendChild(panel);
        document.body.appendChild(toggle);

        // Event delegation on panel for toggle and click
        toggle.addEventListener('click', function (e) {
            e.stopPropagation();
            togglePanel();
        });

        applyPanelState(panel, toggle);
    }

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

    function togglePanel() {
        panelVisible = !panelVisible;
        var panel = document.getElementById('md-view-outline-panel');
        var toggle = document.getElementById('md-view-outline-toggle');
        if (panel && toggle) { applyPanelState(panel, toggle); }
        savePanelVisible();
    }

    function processOutline() {
        var dataEl = document.getElementById('md-view-outline-data');
        if (!dataEl) {
            // Data element may not be in DOM yet after content update; retry once
            setTimeout(function () {
                var retryEl = document.getElementById('md-view-outline-data');
                if (retryEl) { doRender(retryEl); }
            }, 60);
            return;
        }
        doRender(dataEl);
    }

    function doRender(dataEl) {
        var raw = dataEl.getAttribute('data-outline');
        if (!raw) {
            clearOutline();
            return;
        }

        var items;
        try { items = JSON.parse(raw); } catch (e) { clearOutline(); return; }

        var tree = document.getElementById('md-view-outline-tree');
        var footer = document.getElementById('md-view-outline-footer');

        if (!tree) { return; }

        if (!items || items.length === 0) {
            tree.innerHTML = '<div style="padding:12px;color:var(--vscode-descriptionForeground);font-size:11px;">\u6ca1\u6709\u6807\u9898</div>';
            if (footer) { footer.textContent = '0 \u4e2a\u6807\u9898'; }
            currentOutline = null;
            activeId = null;
            scrollActiveId = null;
            return;
        }

        items.forEach(function (item) {
            var idx = Math.min(item.level, 6) - 1;
            item.prefix = LEVEL_PREFIXES[idx];
        });

        var outlineTree = buildTree(items);
        currentOutline = { outline: outlineTree, flat: items };
        renderTree(outlineTree, tree);
        if (footer) { footer.textContent = items.length + ' \u4e2a\u6807\u9898'; }

        activeId = null;
        scrollActiveId = null;
        setTimeout(updateScrollActive, 200);
    }

    function clearOutline() {
        var tree = document.getElementById('md-view-outline-tree');
        var footer = document.getElementById('md-view-outline-footer');
        if (tree) { tree.innerHTML = ''; }
        if (footer) { footer.textContent = '\u8bf7\u6253\u5f00 Markdown \u6587\u4ef6'; }
        currentOutline = null;
        activeId = null;
        scrollActiveId = null;
    }

    function buildTree(items) {
        if (items.length === 0) { return []; }
        var roots = [];
        var stack = [];

        for (var i = 0; i < items.length; i++) {
            var item = items[i];
            while (stack.length > 0 && stack[stack.length - 1].level >= item.level) {
                stack.pop();
            }
            if (stack.length > 0) {
                if (!stack[stack.length - 1].children) { stack[stack.length - 1].children = []; }
                stack[stack.length - 1].children.push(item);
            } else {
                roots.push(item);
            }
            stack.push(item);
        }
        return roots;
    }

    function renderTree(items, tree) {
        tree.innerHTML = items.map(function (item) { return renderItem(item); }).join('');
        // Remove old listener, add fresh
        var newTree = tree.cloneNode(true);
        tree.parentNode.replaceChild(newTree, tree);
        newTree.addEventListener('click', handleTreeClick);
    }

    function renderItem(item) {
        var hasChildren = item.children && item.children.length > 0;
        var collapsed = collapsedItems[item.id] === true;

        var html = '<div class="md-view-item">';
        html += '<div class="md-view-item-row" data-id="' + escAttr(item.id) + '">';
        html += '<span class="md-view-toggle ' + (hasChildren ? '' : 'leaf') + '" data-action="toggle" data-id="' + escAttr(item.id) + '">' + (hasChildren ? (collapsed ? '\u25B6' : '\u25BC') : '') + '</span>';
        html += '<span class="md-view-badge lv' + item.level + '">' + escHtml(item.prefix) + '</span>';
        html += '<span class="md-view-text">' + escHtml(item.text) + '</span>';
        html += '</div>';

        if (hasChildren) {
            html += '<div class="md-view-children' + (collapsed ? ' hidden' : '') + '">';
            html += item.children.map(function (child) { return renderItem(child); }).join('');
            html += '</div>';
        }

        html += '</div>';
        return html;
    }

    function handleTreeClick(e) {
        var target = e.target;
        var action = target.getAttribute('data-action');
        var id = target.getAttribute('data-id');

        if (action === 'toggle') {
            e.stopPropagation();
            toggleCollapse(id);
            return;
        }

        var row = target.closest('.md-view-item-row');
        if (row) {
            var headingId = row.getAttribute('data-id');
            scrollToHeading(headingId);
            setActive(headingId);
        }
    }

    function toggleCollapse(id) {
        collapsedItems[id] = !collapsedItems[id];
        saveCollapsed();

        if (currentOutline && currentOutline.outline) {
            var tree = document.getElementById('md-view-outline-tree');
            if (tree) {
                renderTree(currentOutline.outline, tree);
                if (activeId) {
                    var row = document.querySelector('#md-view-outline-tree .md-view-item-row[data-id="' + CSS.escape(activeId) + '"]');
                    if (row) { row.classList.add('active'); }
                }
                if (scrollActiveId) {
                    var sr = document.querySelector('#md-view-outline-tree .md-view-item-row[data-id="' + CSS.escape(scrollActiveId) + '"]');
                    if (sr) { sr.classList.add('scroll-active'); }
                }
            }
        }
    }

    function scrollToHeading(id) {
        if (!id) { return; }
        var el = document.getElementById(id);
        if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    }

    function setActive(id) {
        if (activeId === id) { return; }

        var tree = document.getElementById('md-view-outline-tree');
        if (!tree) { return; }

        if (activeId) {
            var old = tree.querySelector('.md-view-item-row[data-id="' + CSS.escape(activeId) + '"]');
            if (old) { old.classList.remove('active'); }
        }
        activeId = id;
        scrollActiveId = null;

        var row = tree.querySelector('.md-view-item-row[data-id="' + CSS.escape(id) + '"]');
        if (row) {
            row.classList.remove('scroll-active');
            row.classList.add('active');
            row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
    }

    function updateScrollActive() {
        if (!currentOutline || !currentOutline.flat) { return; }

        var headings = currentOutline.flat;
        var viewportTop = window.scrollY || document.documentElement.scrollTop || 0;
        var viewportMid = viewportTop + window.innerHeight * 0.3;
        var closest = null;
        var closestDist = Infinity;

        for (var i = 0; i < headings.length; i++) {
            var el = document.getElementById(headings[i].id);
            if (!el) { continue; }
            var rect = el.getBoundingClientRect();
            var top = rect.top + viewportTop;
            if (top <= viewportMid) {
                var dist = viewportMid - top;
                if (dist < closestDist) {
                    closestDist = dist;
                    closest = headings[i];
                }
            }
        }

        if (!closest) { return; }

        if (closest.id === activeId) {
            if (scrollActiveId) {
                var sr = document.querySelector('#md-view-outline-tree .md-view-item-row[data-id="' + CSS.escape(scrollActiveId) + '"]');
                if (sr) { sr.classList.remove('scroll-active'); }
                scrollActiveId = null;
            }
            return;
        }

        if (scrollActiveId === closest.id) { return; }

        var tree = document.getElementById('md-view-outline-tree');
        if (!tree) { return; }

        if (scrollActiveId) {
            var old = tree.querySelector('.md-view-item-row[data-id="' + CSS.escape(scrollActiveId) + '"]');
            if (old) { old.classList.remove('scroll-active'); }
        }
        scrollActiveId = closest.id;

        var row = tree.querySelector('.md-view-item-row[data-id="' + CSS.escape(closest.id) + '"]');
        if (row && !row.classList.contains('active')) {
            row.classList.add('scroll-active');
        }
    }

    function escHtml(text) {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function escAttr(text) {
        return text
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    // Start
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
