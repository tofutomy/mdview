(function () {
    'use strict';

    const vscode = acquireVsCodeApi();

    const elements = {
        loading: document.getElementById('loading'),
        error: document.getElementById('error'),
        empty: document.getElementById('empty'),
        outline: document.getElementById('outline'),
        stats: document.getElementById('stats'),
    };

    let currentOutlineData = null;
    let cursorActivatedItem = null;
    let scrollActivatedItem = null;
    let collapsedItems = new Set();

    function init() {
        window.addEventListener('message', handleMessage);
        vscode.postMessage({ command: 'ready' });
    }

    function handleMessage(event) {
        const message = event.data;
        switch (message.command) {
            case 'updateOutline':
                handleUpdateOutline(message.data);
                break;
            case 'highlightCurrentLine':
                handleHighlightCurrentLine(message.line, message.currentItem, message.flatOutline);
                break;
            case 'scrollToLine':
                handleScrollToLine(message.line);
                break;
            case 'clearOutline':
                clearOutline();
                break;
            case 'showError':
                showError(message.error);
                break;
        }
    }

    function handleUpdateOutline(data) {
        currentOutlineData = data;

        if (!data.outline || data.outline.length === 0) {
            showEmpty();
        } else {
            showOutline(data);
        }
    }

    function handleHighlightCurrentLine(line, currentItem, flatOutline) {
        let targetItem = currentItem;
        if (!targetItem && flatOutline) {
            targetItem = findItemByLine(flatOutline, line);
        }
        if (!targetItem && currentOutlineData?.flatOutline) {
            targetItem = findItemByLine(currentOutlineData.flatOutline, line);
        }
        if (targetItem) {
            updateCursorActivation(targetItem);
        }
    }

    function handleScrollToLine(line) {
        if (!currentOutlineData?.flatOutline) return;
        const targetItem = findItemByLine(currentOutlineData.flatOutline, line);
        if (targetItem) {
            updateScrollActivation(targetItem);
        }
    }

    function findItemByLine(flatOutline, targetLine) {
        if (!flatOutline || flatOutline.length === 0 || targetLine < 0) return null;
        let bestMatch = null;
        for (const item of flatOutline) {
            if (item.line <= targetLine) {
                bestMatch = item;
            } else {
                break;
            }
        }
        return bestMatch;
    }

    function updateCursorActivation(targetItem) {
        if (cursorActivatedItem && cursorActivatedItem.line === targetItem.line) return;
        cursorActivatedItem = targetItem;
        applyActivationStyles();
        expandToItem(targetItem);
        let element = document.querySelector('.outline-item-content[data-line="' + targetItem.line + '"]');
        if (element) {
            scrollToItem(element);
        }
    }

    function updateScrollActivation(targetItem) {
        if (cursorActivatedItem && cursorActivatedItem.line === targetItem.line) {
            scrollActivatedItem = null;
            applyActivationStyles();
            return;
        }
        scrollActivatedItem = targetItem;
        applyActivationStyles();
        let element = document.querySelector('.outline-item-content[data-line="' + targetItem.line + '"]');
        if (element) {
            scrollToItemWithoutActivation(element);
        }
    }

    function applyActivationStyles() {
        document.querySelectorAll('.outline-item-content.current, .outline-item-content.scroll-active').forEach(function (el) {
            el.classList.remove('current', 'scroll-active');
        });

        if (scrollActivatedItem) {
            let el = document.querySelector('.outline-item-content[data-line="' + scrollActivatedItem.line + '"]');
            if (el) el.classList.add('scroll-active');
        }

        if (cursorActivatedItem) {
            let el = document.querySelector('.outline-item-content[data-line="' + cursorActivatedItem.line + '"]');
            if (el) el.classList.add('current');
        }
    }

    function expandToItem(targetItem) {
        if (!targetItem || !currentOutlineData) return;
        let path = findPathToItem(currentOutlineData.outline, targetItem);
        path.forEach(function (item) {
            let itemId = 'item-' + item.line;
            if (collapsedItems.has(itemId)) {
                collapsedItems.delete(itemId);
                let indicator = document.querySelector('[data-item-id="' + itemId + '"].collapse-indicator');
                let children = document.querySelector('[data-parent="' + itemId + '"]');
                if (indicator && children) {
                    indicator.classList.remove('collapsed');
                    indicator.classList.add('expanded');
                    children.classList.remove('hidden');
                }
            }
        });
    }

    function findPathToItem(outline, targetItem, currentPath) {
        if (!currentPath) currentPath = [];
        for (let i = 0; i < outline.length; i++) {
            let item = outline[i];
            if (item.line === targetItem.line) {
                return currentPath.concat([item]);
            }
            if (item.children && item.children.length > 0) {
                let pathInChildren = findPathToItem(item.children, targetItem, currentPath.concat([item]));
                if (pathInChildren.length > 0) return pathInChildren;
            }
        }
        return [];
    }

    function scrollToItem(element) {
        if (!element) return;
        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    function scrollToItemWithoutActivation(element) {
        if (!element) return;
        let container = elements.outline.parentElement;
        let containerRect = container.getBoundingClientRect();
        let elementRect = element.getBoundingClientRect();
        let isVisible = elementRect.top >= containerRect.top && elementRect.bottom <= containerRect.bottom;
        if (!isVisible) {
            element.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
    }

    function showOutline(data) {
        hideAllViews();
        elements.outline.classList.remove('hidden');
        elements.outline.innerHTML = renderOutlineTree(data.outline);
        setupOutlineEvents();
        let fileName = data.filePath ? data.filePath.split(/[\\/]/).pop() : '';
        elements.stats.textContent = fileName + ' \u2022 ' + data.totalItems + ' \u4e2a\u6807\u9898';
    }

    function renderOutlineTree(items) {
        if (!items || items.length === 0) return '';
        return items.map(function (item) { return renderOutlineItem(item); }).join('');
    }

    function renderOutlineItem(item) {
        let itemId = 'item-' + item.line;
        let hasChildren = item.children && item.children.length > 0;
        let isCollapsed = collapsedItems.has(itemId);

        let html = '<div class="outline-item">';
        html += '<div class="outline-item-content level-' + item.level + '" data-line="' + item.line + '" data-item-id="' + itemId + '" title="' + escapeAttr(item.text) + ' (\u7b2c' + (item.line + 1) + '\u884c)">';
        html += '<span class="collapse-indicator ' + (hasChildren ? (isCollapsed ? 'collapsed' : 'expanded') : 'leaf') + '" data-item-id="' + itemId + '"></span>';
        html += '<span class="level-badge level-' + item.level + '">' + item.prefix + '</span>';
        html += '<span class="item-title">' + escapeHtml(item.text) + '</span>';
        html += '<span class="item-line">' + (item.line + 1) + '</span>';
        html += '</div>';

        if (hasChildren) {
            html += '<div class="outline-children' + (isCollapsed ? ' hidden' : '') + '" data-parent="' + itemId + '">';
            html += renderOutlineTree(item.children);
            html += '</div>';
        }

        html += '</div>';
        return html;
    }

    function setupOutlineEvents() {
        elements.outline.addEventListener('click', function (event) {
            let itemContent = event.target.closest('.outline-item-content');
            let collapseIndicator = event.target.closest('.collapse-indicator');

            if (collapseIndicator && !collapseIndicator.classList.contains('leaf')) {
                event.stopPropagation();
                toggleItemCollapse(collapseIndicator.dataset.itemId);
            } else if (itemContent) {
                let line = parseInt(itemContent.dataset.line);
                vscode.postMessage({ command: 'jumpToLine', line: line });
            }
        });
    }

    function toggleItemCollapse(itemId) {
        let indicator = document.querySelector('[data-item-id="' + itemId + '"].collapse-indicator');
        let children = document.querySelector('[data-parent="' + itemId + '"]');
        if (!indicator || !children) return;

        if (collapsedItems.has(itemId)) {
            collapsedItems.delete(itemId);
            indicator.classList.remove('collapsed');
            indicator.classList.add('expanded');
            children.classList.remove('hidden');
        } else {
            collapsedItems.add(itemId);
            indicator.classList.remove('expanded');
            indicator.classList.add('collapsed');
            children.classList.add('hidden');
        }
    }

    function showError(errorMessage) {
        hideAllViews();
        elements.error.classList.remove('hidden');
        elements.error.textContent = errorMessage;
    }

    function showEmpty() {
        hideAllViews();
        elements.empty.classList.remove('hidden');
        elements.stats.textContent = '\u6ca1\u6709\u627e\u5230\u6807\u9898';
    }

    function clearOutline() {
        hideAllViews();
        elements.outline.innerHTML = '';
        elements.stats.textContent = '\u8bf7\u6253\u5f00 Markdown \u6587\u4ef6';
        currentOutlineData = null;
        cursorActivatedItem = null;
        scrollActivatedItem = null;
        collapsedItems.clear();
        elements.empty.classList.remove('hidden');
    }

    function hideAllViews() {
        elements.loading.classList.add('hidden');
        elements.error.classList.add('hidden');
        elements.empty.classList.add('hidden');
        elements.outline.classList.add('hidden');
    }

    function escapeHtml(text) {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function escapeAttr(text) {
        return text
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    init();
})();
