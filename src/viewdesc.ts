import {DOMSerializer, Fragment, Mark, Node, ParseRule} from "prosemirror-model"
import {TextSelection} from "prosemirror-state"

import {domIndex, isEquivalentPosition, nodeSize, DOMNode} from "./dom"
import * as browser from "./browser"
import {Decoration, DecorationSource, WidgetConstructor, WidgetType, NodeType} from "./decoration"
import {EditorView} from "./index"
import schedule, { SchedulePriority } from "./schedule"

declare global {
  interface Node { pmViewDesc?: ViewDescRenderer }
}

/// By default, document nodes are rendered using the result of the
/// [`toDOM`](#model.NodeSpec.toDOM) method of their spec, and managed
/// entirely by the editor. For some use cases, such as embedded
/// node-specific editing interfaces, you want more control over
/// the behavior of a node's in-editor representation, and need to
/// [define](#view.EditorProps.nodeViews) a custom node view.
///
/// Mark views only support `dom` and `contentDOM`, and don't support
/// any of the node view methods.
///
/// Objects returned as node views must conform to this interface.
export interface NodeView {
  /// The outer DOM node that represents the document node.
  dom: DOMNode

  /// The DOM node that should hold the node's content. Only meaningful
  /// if the node view also defines a `dom` property and if its node
  /// type is not a leaf node type. When this is present, ProseMirror
  /// will take care of rendering the node's children into it. When it
  /// is not present, the node view itself is responsible for rendering
  /// (or deciding not to render) its child nodes.
  contentDOM?: HTMLElement | null

  /// When given, this will be called when the view is updating itself.
  /// It will be given a node (possibly of a different type), an array
  /// of active decorations around the node (which are automatically
  /// drawn, and the node view may ignore if it isn't interested in
  /// them), and a [decoration source](#view.DecorationSource) that
  /// represents any decorations that apply to the content of the node
  /// (which again may be ignored). It should return true if it was
  /// able to update to that node, and false otherwise. If the node
  /// view has a `contentDOM` property (or no `dom` property), updating
  /// its child nodes will be handled by ProseMirror.
  update?: (node: Node, decorations: readonly Decoration[], innerDecorations: DecorationSource) => boolean

  /// Can be used to override the way the node's selected status (as a
  /// node selection) is displayed.
  selectNode?: () => void

  /// When defining a `selectNode` method, you should also provide a
  /// `deselectNode` method to remove the effect again.
  deselectNode?: () => void

  /// This will be called to handle setting the selection inside the
  /// node. The `anchor` and `head` positions are relative to the start
  /// of the node. By default, a DOM selection will be created between
  /// the DOM positions corresponding to those positions, but if you
  /// override it you can do something else.
  setSelection?: (anchor: number, head: number, root: Document | ShadowRoot) => void

  /// Can be used to prevent the editor view from trying to handle some
  /// or all DOM events that bubble up from the node view. Events for
  /// which this returns true are not handled by the editor.
  stopEvent?: (event: Event) => boolean

  /// Called when a DOM
  /// [mutation](https://developer.mozilla.org/en-US/docs/Web/API/MutationObserver)
  /// or a selection change happens within the view. When the change is
  /// a selection change, the record will have a `type` property of
  /// `"selection"` (which doesn't occur for native mutation records).
  /// Return false if the editor should re-read the selection or
  /// re-parse the range around the mutation, true if it can safely be
  /// ignored.
  ignoreMutation?: (mutation: MutationRecord) => boolean

  /// Called when the node view is removed from the editor or the whole
  /// editor is destroyed. (Not available for marks.)
  destroy?: () => void
}

// View descriptions are data structures that describe the DOM that is
// used to represent the editor's content. They are used for:
//
// - Incremental redrawing when the document changes
//
// - Figuring out what part of the document a given DOM position
//   corresponds to
//
// - Wiring in custom implementations of the editing interface for a
//   given node
//
// They form a doubly-linked mutable tree, starting at `view.docView`.

type ViewDescSet = Set<ViewDescRenderer>;

interface IBufferNodes {
  upward: ViewDescSet;
  downward: ViewDescSet;
}

interface IStyle {
  height: number;
  marginTop: number;
  marginBottom: number;
}

interface ILayoutInfo extends IStyle {
  offsetTopToParent: number;
  isDirty: boolean;
}

interface IRect extends IStyle {
  top: number;
  bottom: number;
  left: number;
  node: ViewDescRenderer;
}

interface IViewport {
  buffer?: number,
  scrollTop: number;
  scrollHeight: number;
}

interface IPlaceholderInfo {
  range: [number, number];
  dom: HTMLDivElement;
  style: {
    height: number;
    marginTop: number;
    marginBottom: number;
  };
}

interface IUpdateViewportOptions {
  preventUnmount?: boolean;
}

const NOT_DIRTY = 0, CHILD_DIRTY = 1, CONTENT_DIRTY = 2, NODE_DIRTY = 3
enum LayoutMode {
  Vertical = 'vertical',
  Horizontal = 'horizontal',
};

export enum WalkDirection {
  Up = 'Up',
  Down = 'Down',
};

export enum WalkStrategy {
  Pre = 'preOrder',
  Post = 'postOrder',
};

type IWalkCondition = (node: ViewDescRenderer) => boolean;

class PlaceholderInfo {
  range: [number, number];
  dom: HTMLDivElement;
  style: IStyle;

  constructor(public parent: ViewDescRenderer) {
    this.dom = document.createElement('div');
    this.dom.classList.add('prosemirror-line-placeholder');
    this.dom.pmViewDesc = parent;
    this.range = [-1, -1];
    this.style = {
      height: 0,
      marginTop: 0,
      marginBottom: 0
    };
  }
}

export abstract class ViewDescRenderer {
  placeholderPool: PlaceholderInfo[] = [];

  node!: Node | null

  /**
   * 当前所有已经挂载的节点列表
   */
  mountedNodes: ViewDescSet = new Set();

  /**
   * 当前处于视口外 buffer 内的节点列表
   */
  bufferNodes: IBufferNodes = {
    upward: new Set(),
    downward: new Set(),
  }

  /**
   * 当前处于视口内的节点列表
   */
  viewportNodes: ViewDescSet = new Set();

  /**
   * 该节点是否保留在 DOM 不卸载
   * 如为 true，则保留，如选区所在节点，会被自动设置为 true
   */
  keep: boolean;

  /**
   * 正在使用的 Placeholder 列表
   */
  usedPlaceholder: PlaceholderInfo[] = [];

  /**
   * 是否已经渲染
   * 只有 fake 节点为 false，其余均为 true
   */
  isRendered = true;

  /**
   * 当前节点的布局信息
   */
  public layoutInfo: ILayoutInfo = {
    height: 26,
    marginTop: 0,
    marginBottom: 0,
    offsetTopToParent: 0,
    isDirty: true,
  }

  /**
   * 预渲染区节点
   */
  protected prerenderPool?: HTMLElement;

  private rects: IRect[] | null = null;

  abstract posBefore: number;

  constructor(
    public parent: ViewDesc | undefined,
    public children: ViewDesc[],
    public dom: DOMNode,
    public contentDOM: HTMLElement | null,
    public isRoot: boolean,
  ) {
    if (isRoot) {
      this.isRendered = true;
      this.initPrerenderPool();
    }
  }

  get mode() {
    return this.node?.type.spec.layoutMode;
  }

  getRects(): IRect[] {
    if (this.rects) return this.rects;

    if (this.mode === LayoutMode.Horizontal) {
      this.rects = this.children.map((child) => {
        const { height, marginTop, marginBottom, offsetTopToParent } = child.layoutInfo;
        return {
          top: offsetTopToParent,
          left: 0,
          height,
          marginTop,
          marginBottom,
          bottom: height + marginBottom,
          node: child,
        }
      });
    } else {
      const len = this.children.length;
      this.rects = new Array(len);

      for (let index = 0; index < len; index++) {
        const child = this.children[index];
        const last = index > 0 ? this.rects[index - 1] : { top: 0, marginBottom: 0, height: 0 };
        const { height, marginTop, marginBottom, offsetTopToParent } = child.layoutInfo;
        const curTop = last.top + last.height + Math.max(last.marginBottom, marginTop) + offsetTopToParent;

        this.rects[index] = {
          left: 0,
          top: curTop,
          bottom: curTop + height,
          marginTop,
          marginBottom,
          height,
          node: child,
        };
      }
    }

    return this.rects;
  }

  clearRects() {
    this.rects = null;
  }

  markLayoutDirty() {
    this.clearRects();
    this.layoutInfo.isDirty = true;

    this.climb(node => {
      node.clearRects();
      node.layoutInfo.isDirty = true;
      return false;
    });
  }

  inBuffer() {
    for (let parent = this.parent, child = this, buffer = false; parent; child = parent, parent = child.parent) {
      if (child.node?.isInline || child instanceof MarkViewDesc) continue;
      if (!buffer && !parent.bufferNodes.upward.has(child) && !parent.bufferNodes.downward.has(child)) return false;
      buffer = true;
      if (!parent.mountedNodes.has(child)) return false;
    }
    return true;
  }

  inViewport() {
    for (let parent = this.parent, child = this; parent; child = parent, parent = child.parent) {
      if (child.node?.isInline || child instanceof MarkViewDesc) continue;
      if (!parent.viewportNodes.has(child)) return false;
      if (parent.isRoot) return true;
    }
    return false;
  }

  /**
   * 更新当前节点的布局信息，更新完成 isDirty 为 false
   */
  layout() {
    if (!this.node || this.node.isInline || !(this.dom instanceof HTMLElement)) return;
    if (!this.dom.isConnected) {
      this.parent?.ensureChildMounted(this);
    }

    const style = getComputedStyle(this.dom);
    const height = parseFloat(style.height) || this.dom.getBoundingClientRect().height;
    const marginTop = parseFloat(style.marginTop);
    const marginBottom = parseFloat(style.marginBottom);

    const isFirstChild = this.parent?.mode === LayoutMode.Horizontal || (this as unknown as ViewDesc) === this.parent?.children[0];

    let offsetTopToParent = this.layoutInfo.offsetTopToParent;

    if (isFirstChild && this.parent?.layoutInfo.isDirty && this.parent.mountedNodes.has(this)) {
      const parentTop = (this.parent.dom as HTMLElement).getBoundingClientRect().top;
      const top = this.dom.getBoundingClientRect().top;
      offsetTopToParent = top - parentTop;
    }

    const deltas =
      [this.layoutInfo.height - height,
      this.layoutInfo.marginTop - marginTop,
      this.layoutInfo.marginBottom - marginBottom,
      this.layoutInfo.offsetTopToParent - offsetTopToParent];

    this.layoutInfo = {
      height,
      marginTop,
      marginBottom,
      offsetTopToParent,
      isDirty: false,
    };

    // TODO: 算的有问题
    if (deltas.some(delta => !delta)) {
      // this.updateParentLayout(deltas);
      this.parent?.clearRects();
      this.parent?.markLayoutDirty();
    }
  }

  private updateParentLayout([dtHeight, dtMarginTop = 0, dtMarginBottom = 0]: number[]) {
    if (!this.parent || this.parent.isRoot) return this.parent?.clearRects();

    const index = this.parent.children.indexOf(this);

    if (index === -1) throw new Error(`Child doesn't exist on parent: ${this}`);

    const prevSibling = this.parent.children[index - 1];
    const nextSibling = this.parent.children[index + 1];
    const { marginBottom, marginTop } = this.layoutInfo;

    dtMarginTop = !nextSibling ? dtMarginTop :
      marginBottom > nextSibling.layoutInfo.marginTop ? marginBottom - nextSibling.layoutInfo.marginTop : 0;
    dtMarginBottom = !prevSibling ? dtMarginBottom :
    marginTop > prevSibling.layoutInfo.marginBottom ? marginTop - prevSibling.layoutInfo.marginBottom : 0;

    const delta = dtHeight + dtMarginTop + dtMarginBottom;
    this.parent.layoutInfo.height += delta;
    this.parent?.clearRects();
    this.parent?.markLayoutDirty();

    this.parent.updateParentLayout([delta]);
  }

  /**
   * 计算视口信息
   * 返回:
   * 当前视口应该被挂载的节点 {mounts}
   * 应该被卸载的节点 {unmounts}
   * 当前视口内的节点 {viewportNodes}
   * 当前 buffer 内的节点 {bufferNodes}
   */
  private calculateViewport(view: EditorView, viewport: IViewport) {
    const shouldMountNodes: ViewDescSet = new Set();
    const bufferNodes: IBufferNodes = {
      upward: new Set(),
      downward: new Set(),
    };
    const viewportNodes: ViewDescSet = new Set();

    const { scrollTop, scrollHeight, buffer = 0 } = viewport;
    const scrollBottom = scrollTop + scrollHeight;
    const isHorizontal = this.mode === LayoutMode.Horizontal;

    const rects = this.getRects();
    for (let i = 0; i < rects.length; i++) {
      const rect = rects[i];
      const { top, bottom, node } = rect;

      if ( // in buffer
        scrollTop - buffer <= bottom &&
        scrollBottom + buffer >= top
      ) {
        shouldMountNodes.add(node);

        if ( // in viewport
          scrollTop <= bottom &&
          scrollBottom >= top
        ) {
          viewportNodes.add(node);
        } else if (scrollTop > bottom) {
          bufferNodes.upward.add(node);
        } else {
          bufferNodes.downward.add(node);
        }
      }

      // 提前结束循环，看是否需要改成二分法计算
      if (!isHorizontal && scrollBottom + buffer < top) {
        break;
      }
    }

    const unmounts = new Set(Array.from(this.mountedNodes).filter(node => {
      return !shouldMountNodes.has(node);
    }));
    const mounts = new Set(Array.from(shouldMountNodes).filter(node => {
      return !this.mountedNodes.has(node);
    }));

    return { mounts, unmounts, viewportNodes, bufferNodes };
  }

  walk(
    direction: WalkDirection,
    strategy: WalkStrategy,
    condition: IWalkCondition,
    start = (direction === WalkDirection.Down ? 0 : this.children.length - 1)
  ) {
    let index = start;
    while (index >= 0 && index <= this.children.length - 1) {
      const node = this.children[index];

      if (strategy === WalkStrategy.Pre) {
        if (condition(node) || node.walk(direction, strategy, condition)) return true;
      } else {
        if (node.walk(direction, strategy, condition) || condition(node)) return true;
      }

      direction === WalkDirection.Down ? index++ : index--;
    }
    return false;
  }

  climb(fn: (node: ViewDescRenderer) => boolean) {
    for (let node = this.parent; node; node = node.parent) {
      if (fn(node)) return true;
    }
    return false;
  }

  /**
   * 获取最深的首个视口内的节点
   */
  getInnerViewportNode(): ViewDescRenderer | undefined {
    if (this.node?.isTextblock) {
      return this;
    } else {
      const [first] = this.viewportNodes;
      return first?.getInnerViewportNode() || first || this;
    }
  }

  /**
   * 获取节点到 Root 的距离
   */
  getOffsetTopToRoot() {
    let top = 0;
    let child: ViewDescRenderer | undefined = this;
    let parent = this.parent;
    while (parent && child) {
      const index = parent.children.indexOf(child);
      top += parent.getRects()[index].top;

      child = child?.parent;
      parent = child?.parent;
    }
    return top;
  }

  /**
   * 获取节点到视口的 rect
   */
  getBoundingRect() {
    if (this.dom.isConnected && this.dom instanceof HTMLElement) return this.dom.getBoundingClientRect();

    let root = this.parent;
    while (root && !root.isRoot) {
      root = root.parent;
    }

    if (!root || !(root.dom instanceof HTMLElement)) throw new Error('Can not find root node view desc');

    const rootRect = root.dom.getBoundingClientRect();
    const top = this.getOffsetTopToRoot();
    return {
      top: top + rootRect.top,
      bottom: top + rootRect.top + this.layoutInfo.height,
      left: rootRect.left,
      right: rootRect.right,
    }
  }

  /**
   * 虚拟滚动核心更新函数
   * 1. 根据视口信息，计算出视口内应该被挂载或卸载的节点
   * 2. 对需要卸载的节点计算 layout，保证准确性（读 DOM）
   * 3. 对需要挂载的节点判断是否已经渲染，如否，则先进行渲染
   * 4. 对可能变化的节点递归处理其子节点的视口情况
   * 5. 挂载或卸载相应节点，更新 Placeholder
   */
  updateViewport(view: EditorView, viewport: IViewport, options: IUpdateViewportOptions = {}) {
    if (this.node?.isTextblock) return;

    const { mounts, unmounts, viewportNodes, bufferNodes } = this.calculateViewport(view, viewport);

    if (options.preventUnmount) unmounts.clear();

    const prevBufferNodes = this.bufferNodes
    const prevViewportNodes = this.viewportNodes;
    this.bufferNodes = bufferNodes;
    this.viewportNodes = viewportNodes;

    // 先读 dom
    this.layoutChildren(unmounts);

    // 保证 mounts 节点已经渲染, 只挂载 text 节点
    this.ensureChildrenRendered(view, mounts);

    // 再调用子节点的 update
    this.updateDescendantViewport(view, mounts, prevBufferNodes,prevViewportNodes, viewport);

    // 最后写 dom
    const { mounts: realMounts, unmounts: realUnmounts } = this.mountChildren(view, mounts, unmounts);

    this.layoutMountsInSchedule();

  }

  /// @internal
  ensureChildrenRendered(view: EditorView, mounts: ViewDescSet, parentPos?: number) {
    if (!Array.from(mounts).find(child => child instanceof MarkViewDesc || !child.isRendered)) return;
    const pos = parentPos ?? (this instanceof NodeViewDesc && this.parent?.posBeforeChild(this) || 0);
    return this.children.reduce((pos, child, index) => {
      if (child instanceof MarkViewDesc) return child.ensureChildrenRendered(view, new Set(child.children), pos)
      if (!mounts.has(child) || !(child instanceof FakeNodeViewDesc)) return pos + (child.node?.nodeSize || 0);

      const rendered = child.render(view, pos);
      rendered.children = child.children;
      child.children.forEach(node => node.parent = rendered);
      this.children.splice(index, 1, rendered);

      if (rendered.node.isTextblock) {
        // rendered.ensureChildrenRendered(view, new Set(rendered.children), pos);
        rendered.updateChildren(view, pos, false);
        renderDescs(rendered.contentDOM!, rendered.children, view)
      }

      mounts.delete(child);
      mounts.add(rendered);

      rendered.parent!.clearRects();

      return pos + (child.node?.nodeSize || 0);
    }, pos + 1);
  }

  /**
   * 为减少计算量，不对 unmount 的子节点再进行卸载
   * 仅对 mounts 和处于视口边界的两个节点计算。
   */
  private updateDescendantViewport(
    view: EditorView,
    mounts: ViewDescSet,
    bufferNodes: IBufferNodes,
    viewportNodes: ViewDescSet,
    viewport: IViewport,
  ) {
    const { scrollTop, scrollHeight, buffer } = viewport;
    const edgeNodes = this.mode === LayoutMode.Horizontal ? this.mountedNodes : this.edgeDescNodes(bufferNodes, viewportNodes);
    const layouts = this.getRects().filter(({ node }) => mounts.has(node) || edgeNodes.has(node));
    layouts.forEach(({ node, top, bottom, height }) => {
      // TODO: 改回高度
      const childViewportHeight = scrollTop <= top && bottom <= scrollTop + scrollHeight ?
        Infinity :
        overlapHeight({ top: scrollTop, bottom: scrollTop + scrollHeight }, { top, bottom });

      node.updateViewport(view, {
        buffer,
        scrollTop: Math.max(scrollTop - top, 0),
        scrollHeight: childViewportHeight,
      });
    });
  }

  /**
   * 对传入的 mounts 和 unmounts 节点进行挂载和卸载
   */
  mountChildren(view?: EditorView, mounts?: ViewDescSet, unmounts?: ViewDescSet) {
    // validate
    mounts = new Set(mounts && Array.from(mounts).filter(node => !this.mountedNodes.has(node)));
    unmounts = new Set(unmounts && Array.from(unmounts).filter(node => !node.shouldKeep(view) && this.mountedNodes.has(node)));

    // update mountedNodes
    mounts.forEach(node => this.mountedNodes.add(node));
    unmounts.forEach(node => this.mountedNodes.delete(node));

    const placeholderInfos = this.getPlaceholderInfos();

    if (!mounts.size && !unmounts.size && !placeholderInfos.length) return { mounts, unmounts };

    placeholderInfos.forEach(info => {
      this.updatePlaceholderStyle(info);
    });
    const arr = this.children.reduce<(ViewDescRenderer | IPlaceholderInfo)[]>((arr, child, index) => {
      if (this.mountedNodes.has(child)) {
        arr.push(child);
      } else {
        const last = arr[arr.length - 1];
        if (!last || last instanceof ViewDescRenderer) {
          arr.push(placeholderInfos.shift()!);
        }
      }
      return arr;
    }, []);

    renderDescs(this.contentDOM!, arr, view);

    // return actually changed nodes
    return { mounts, unmounts };
  }

  ensureChildMounted(child: ViewDescRenderer) {
    if (this.isRoot && !this.mountedNodes.has(child)) {
      this.prerenderPool!.appendChild(child.dom);
      schedule.addTask({
        priority: SchedulePriority.Low,
        callback: () => {
          this.prerenderPool?.childNodes.forEach((child) => {
            const found = child.pmViewDesc?.walk(WalkDirection.Down, WalkStrategy.Pre, (node) => !node.isRendered);
            if (!found) child.remove();
          });
        }
      })
    } else this.mountChildren(undefined, new Set([child]));
    this.parent?.ensureChildMounted(this);
  }

  destroy() {
    this.prerenderPool?.remove();
  }

  private edgeDescNodes(
    bufferNodes: IBufferNodes,
    viewportNodes: ViewDescSet,
  ) {
    const [prevFirst] = bufferNodes.upward.size ? bufferNodes.upward : viewportNodes;
    const [...prevRest] = bufferNodes.downward.size ? bufferNodes.downward : viewportNodes;
    const [first] = this.bufferNodes.upward.size ? this.bufferNodes.upward : this.viewportNodes;
    const [...rest] = this.bufferNodes.downward.size ? this.bufferNodes.downward : viewportNodes;
    const edgeNodes = new Set([prevFirst, prevRest[prevRest.length - 1], first, rest[rest.length - 1]]);
    return edgeNodes;
  }

  protected getSelectedTarget(node: DOMNode, offset: number) {
    if (node.isConnected) return { node, offset };

    let root = node.pmViewDesc;

    while (root?.parent && !root.parent.isRoot) {
      root = root.parent;
    }

    if (!root) return { node, offset };

    const index = root.parent!.children.indexOf(root);
    const info = root.parent!.usedPlaceholder.find(({ range: [start, end] }) => start <= index && index <= end );
    return { node: info.dom, offset: 0 };
  }

  private getPlaceholderInfos() {
    const placeholderRanges = this.children.reduce<[number, number][]>((ranges, child, index) => {
      if (this.mountedNodes.has(child)) return ranges;

      const last = ranges[ranges.length - 1];
      if (!last || last[1] !== index - 1) ranges.push([index, index]);
      else last[1] = index;

      return ranges;
    }, []);

    const infos = placeholderRanges.map(([start, end]) => {
      const reuse = this.usedPlaceholder.find(({ range }) => {
        return end >= range[0] && start <= range[1];
      });
      const info = reuse || this.placeholderPool.pop() || new PlaceholderInfo(this);
      info.range = [start, end];
      return info;
    });
    const infoSet = new Set(infos);
    this.usedPlaceholder.forEach(info => {
      if (!infoSet.has(info)) this.placeholderPool.push(info);
    });

    this.usedPlaceholder = [...infos];

    return infos;
  }

  private updatePlaceholderStyle(info: PlaceholderInfo) {
    const rects = this.getRects();
    const { range: [start, end], dom } = info;
    const style = this.mode === LayoutMode.Horizontal ?
      rects.slice(start, end + 1).reduce((style, rect) => ({
        height: Math.max(style.height, rect.height),
        marginTop: Math.max(style.marginTop, rect.marginTop),
        marginBottom: Math.max(style.marginBottom, rect.marginBottom),
      }), { height: 0, marginTop: 0, marginBottom: 0 }) :
      {
        height: rects[end].bottom - rects[start].top,
        marginTop: rects[start].marginTop,
        marginBottom: rects[end].marginBottom,
      };

    const { height, marginTop, marginBottom } = info.style;
    if (style.height !== height || style.marginTop !== marginTop || style.marginBottom !== marginBottom) {
      dom.style.height = `${style.height}px`;
      dom.style.marginTop = `${style.marginTop}px`;
      dom.style.marginBottom = `${style.marginBottom}px`;
    }
    info.style = style;
  }

  private layoutMountsInSchedule() {
    const needLayouts = Array.from(this.mountedNodes).filter(node => node.layoutInfo.isDirty);
    needLayouts.length && schedule.addTask({
      priority: SchedulePriority.High,
      callback: () => {
        const stillMounts = needLayouts.filter(node => node.dom.isConnected);
        this.clearRects();
        this.layoutChildren(new Set(stillMounts));
      },
    })
  }

  private shouldKeep(view?: EditorView) {
    if (!this.parent) return false;

    const selection = getSelection();
    if (!selection || !selection.anchorNode || !selection.focusNode) return !!this.node!.type.spec.keep || this.keep;

    // TODO: 有时并不准确
    const startMark = this.dom.compareDocumentPosition(selection.anchorNode);
    const endMark = this.dom.compareDocumentPosition(selection.focusNode);

    if (
      startMark & window.Node.DOCUMENT_POSITION_CONTAINS ||
      startMark & window.Node.DOCUMENT_POSITION_CONTAINED_BY ||
      endMark & window.Node.DOCUMENT_POSITION_CONTAINED_BY ||
      endMark & window.Node.DOCUMENT_POSITION_CONTAINED_BY ||
      (
        startMark & window.Node.DOCUMENT_POSITION_PRECEDING &&
        endMark & window.Node.DOCUMENT_POSITION_FOLLOWING
      )
    ) {
      return true;
    }

    return !!this.node!.type.spec.keep || this.keep;
  }

  private initPrerenderPool() {
    if (!this.dom.parentElement) return;

    this.prerenderPool = document.createElement('div');
    this.prerenderPool.className = (this.dom as HTMLElement).className + ' prerender-pool';
    this.prerenderPool.style.cssText = `
      position: absolute;
      width: 100%;
      top: -99999px;
      left: -99999px;
    `;

    this.dom.parentElement.style.position = 'relative';
    this.dom.parentElement.appendChild(this.prerenderPool);
  }

  private layoutChildren(children: ViewDescSet) {
    children.forEach(child => child.layout());
  }
}
// Superclass for the various kinds of descriptions. Defines their
// basic structure and shared methods.
export class ViewDesc extends ViewDescRenderer {
  dirty = NOT_DIRTY
  node!: Node | null

  constructor(
    public parent: ViewDesc | undefined,
    public children: ViewDesc[],
    public dom: DOMNode,
    // This is the node that holds the child views. It may be null for
    // descs that don't have children.
    public contentDOM: HTMLElement | null,
    isRoot = false
  ) {
    super(parent, children, dom, contentDOM, isRoot);
    // An expando property on the DOM node provides a link back to its
    // description.
    dom.pmViewDesc = this
  }

  // Used to check whether a given description corresponds to a
  // widget/mark/node.
  matchesWidget(widget: Decoration) { return false }
  matchesMark(mark: Mark) { return false }
  matchesNode(node: Node, outerDeco: readonly Decoration[], innerDeco: DecorationSource) { return false }
  matchesHack(nodeName: string) { return false }

  // When parsing in-editor content (in domchange.js), we allow
  // descriptions to determine the parse rules that should be used to
  // parse them.
  parseRule(): ParseRule | null { return null }

  // Used by the editor's event handler to ignore events that come
  // from certain descs.
  stopEvent(event: Event) { return false }

  // The size of the content represented by this desc.
  get size() {
    let size = 0
    for (let i = 0; i < this.children.length; i++) size += this.children[i].size
    return size
  }

  // For block nodes, this represents the space taken up by their
  // start/end tokens.
  get border() { return 0 }

  destroy() {
    super.destroy();
    this.parent = undefined
    if (this.dom.pmViewDesc == this) this.dom.pmViewDesc = undefined
    for (let i = 0; i < this.children.length; i++)
      this.children[i].destroy()
  }

  posBeforeChild(child: ViewDesc): number {
    for (let i = 0, pos = this.posAtStart;; i++) {
      let cur = this.children[i]
      if (cur == child) return pos
      pos += cur.size
    }
  }

  get posBefore() {
    return this.parent!.posBeforeChild(this)
  }

  get posAtStart() {
    return this.parent ? this.parent.posBeforeChild(this) + this.border : 0
  }

  get posAfter() {
    return this.posBefore + this.size
  }

  get posAtEnd() {
    return this.posAtStart + this.size - 2 * this.border
  }

  localPosFromDOM(dom: DOMNode, offset: number, bias: number): number {
    // If the DOM position is in the content, use the child desc after
    // it to figure out a position.
    if (this.contentDOM && this.contentDOM.contains(dom.nodeType == 1 ? dom : dom.parentNode)) {
      if (bias < 0) {
        let domBefore, desc: ViewDesc | undefined
        if (dom == this.contentDOM) {
          domBefore = dom.childNodes[offset - 1]
        } else {
          while (dom.parentNode != this.contentDOM) dom = dom.parentNode!
          domBefore = dom.previousSibling
        }
        while (domBefore && !((desc = domBefore.pmViewDesc) && desc.parent == this)) domBefore = domBefore.previousSibling
        return domBefore ? this.posBeforeChild(desc!) + desc!.size : this.posAtStart
      } else {
        let domAfter, desc: ViewDesc | undefined
        if (dom == this.contentDOM) {
          domAfter = dom.childNodes[offset]
        } else {
          while (dom.parentNode != this.contentDOM) dom = dom.parentNode!
          domAfter = dom.nextSibling
        }
        while (domAfter && !((desc = domAfter.pmViewDesc) && desc.parent == this)) domAfter = domAfter.nextSibling
        return domAfter ? this.posBeforeChild(desc!) : this.posAtEnd
      }
    }
    // Otherwise, use various heuristics, falling back on the bias
    // parameter, to determine whether to return the position at the
    // start or at the end of this view desc.
    let atEnd
    if (dom == this.dom && this.contentDOM) {
      atEnd = offset > domIndex(this.contentDOM)
    } else if (this.contentDOM && this.contentDOM != this.dom && this.dom.contains(this.contentDOM)) {
      atEnd = dom.compareDocumentPosition(this.contentDOM) & 2
    } else if (this.dom.firstChild) {
      if (offset == 0) for (let search = dom;; search = search.parentNode!) {
        if (search == this.dom) { atEnd = false; break }
        if (search.previousSibling) break
      }
      if (atEnd == null && offset == dom.childNodes.length) for (let search = dom;; search = search.parentNode!) {
        if (search == this.dom) { atEnd = true; break }
        if (search.nextSibling) break
      }
    }
    return (atEnd == null ? bias > 0 : atEnd) ? this.posAtEnd : this.posAtStart
  }

  // Scan up the dom finding the first desc that is a descendant of
  // this one.
  nearestDesc(dom: DOMNode): ViewDesc | undefined
  nearestDesc(dom: DOMNode, onlyNodes: true): NodeViewDesc | undefined
  nearestDesc(dom: DOMNode, onlyNodes: boolean = false) {
    for (let first = true, cur: DOMNode | null = dom; cur; cur = cur.parentNode) {
      let desc = this.getDesc(cur), nodeDOM
      if (desc && (!onlyNodes || desc.node)) {
        // If dom is outside of this desc's nodeDOM, don't count it.
        if (first && (nodeDOM = (desc as NodeViewDesc).nodeDOM) &&
            !(nodeDOM.nodeType == 1 ? nodeDOM.contains(dom.nodeType == 1 ? dom : dom.parentNode) : nodeDOM == dom))
          first = false
        else
          return desc
      }
    }
  }

  getDesc(dom: DOMNode) {
    let desc = dom.pmViewDesc
    for (let cur: ViewDesc | undefined = desc; cur; cur = cur.parent) if (cur == this) return desc
  }

  posFromDOM(dom: DOMNode, offset: number, bias: number) {
    for (let scan: DOMNode | null = dom; scan; scan = scan.parentNode) {
      let desc = this.getDesc(scan)
      if (desc) return desc.localPosFromDOM(dom, offset, bias)
    }
    return -1
  }

  // Find the desc for the node after the given pos, if any. (When a
  // parent node overrode rendering, there might not be one.)
  descAt(pos: number): ViewDesc | undefined {
    for (let i = 0, offset = 0; i < this.children.length; i++) {
      let child = this.children[i], end = offset + child.size
      if (offset == pos && end != offset) {
        while (!child.border && child.children.length) child = child.children[0]
        return child
      }
      if (pos < end) return child.descAt(pos - offset - child.border)
      offset = end
    }
  }

  domFromPos(pos: number, side: number): {node: DOMNode, offset: number, atom?: number} {
    if (!this.contentDOM) return {node: this.dom, offset: 0, atom: pos + 1}
    // First find the position in the child array
    let i = 0, offset = 0
    for (let curPos = 0; i < this.children.length; i++) {
      let child = this.children[i], end = curPos + child.size
      if (end > pos || child instanceof TrailingHackViewDesc) { offset = pos - curPos; break }
      curPos = end
    }
    // If this points into the middle of a child, call through
    if (offset) return this.children[i].domFromPos(offset - this.children[i].border, side)
    // Go back if there were any zero-length widgets with side >= 0 before this point
    for (let prev; i && !(prev = this.children[i - 1]).size && prev instanceof WidgetViewDesc && prev.side >= 0; i--) {}
    // Scan towards the first useable node
    if (side <= 0) {
      let prev, enter = true
      for (;; i--, enter = false) {
        prev = i ? this.children[i - 1] : null
        if (!prev || prev.dom.parentNode == this.contentDOM) break
      }
      if (prev && side && enter && !prev.border && !prev.domAtom) return prev.domFromPos(prev.size, side)
      return {node: this.contentDOM, offset: prev ? domIndex(prev.dom) + 1 : 0}
    } else {
      let next, enter = true
      for (;; i++, enter = false) {
        next = i < this.children.length ? this.children[i] : null
        if (!next || next.dom.parentNode == this.contentDOM) break
      }
      if (next && enter && !next.border && !next.domAtom) return next.domFromPos(0, side)
      return {node: this.contentDOM, offset: next ? domIndex(next.dom) : this.contentDOM.childNodes.length}
    }
  }

  // Used to find a DOM range in a single parent for a given changed
  // range.
  parseRange(
    from: number, to: number, base = 0
  ): {node: DOMNode, from: number, to: number, fromOffset: number, toOffset: number} {
    if (this.children.length == 0)
      return {node: this.contentDOM!, from, to, fromOffset: 0, toOffset: this.contentDOM!.childNodes.length}

    let fromOffset = -1, toOffset = -1
    for (let offset = base, i = 0;; i++) {
      let child = this.children[i], end = offset + child.size
      if (fromOffset == -1 && from <= end) {
        let childBase = offset + child.border
        // FIXME maybe descend mark views to parse a narrower range?
        if (from >= childBase && to <= end - child.border && child.node &&
            child.contentDOM && this.contentDOM!.contains(child.contentDOM))
          return child.parseRange(from, to, childBase)

        from = offset
        for (let j = i; j > 0; j--) {
          let prev = this.children[j - 1]
          if (prev.size && prev.dom.parentNode == this.contentDOM && !prev.emptyChildAt(1)) {
            fromOffset = domIndex(prev.dom) + 1
            break
          }
          from -= prev.size
        }
        if (fromOffset == -1) fromOffset = 0
      }
      if (fromOffset > -1 && (end > to || i == this.children.length - 1)) {
        to = end
        for (let j = i + 1; j < this.children.length; j++) {
          let next = this.children[j]
          if (next.size && next.dom.parentNode == this.contentDOM && !next.emptyChildAt(-1)) {
            toOffset = domIndex(next.dom)
            break
          }
          to += next.size
        }
        if (toOffset == -1) toOffset = this.contentDOM!.childNodes.length
        break
      }
      offset = end
    }
    return {node: this.contentDOM!, from, to, fromOffset, toOffset}
  }

  emptyChildAt(side: number): boolean {
    if (this.border || !this.contentDOM || !this.children.length) return false
    let child = this.children[side < 0 ? 0 : this.children.length - 1]
    return child.size == 0 || child.emptyChildAt(side)
  }

  domAfterPos(pos: number): DOMNode {
    let {node, offset} = this.domFromPos(pos, 0)
    if (node.nodeType != 1 || offset == node.childNodes.length)
      throw new RangeError("No node after pos " + pos)
    return node.childNodes[offset]
  }

  // View descs are responsible for setting any selection that falls
  // entirely inside of them, so that custom implementations can do
  // custom things with the selection. Note that this falls apart when
  // a selection starts in such a node and ends in another, in which
  // case we just use whatever domFromPos produces as a best effort.
  setSelection(anchor: number, head: number, root: Document | ShadowRoot, force = false): void {
    // If the selection falls entirely in a child, give it to that child
    let from = Math.min(anchor, head), to = Math.max(anchor, head)
    for (let i = 0, offset = 0; i < this.children.length; i++) {
      let child = this.children[i], end = offset + child.size
      if (from > offset && to < end)
        return child.setSelection(anchor - offset - child.border, head - offset - child.border, root, force)
      offset = end
    }

    let anchorDOM = this.domFromPos(anchor, anchor ? -1 : 1)
    let headDOM = head == anchor ? anchorDOM : this.domFromPos(head, head ? -1 : 1)
    let domSel = (root as Document).getSelection()!

    let brKludge = false
    // On Firefox, using Selection.collapse to put the cursor after a
    // BR node for some reason doesn't always work (#1073). On Safari,
    // the cursor sometimes inexplicable visually lags behind its
    // reported position in such situations (#1092).
    if ((browser.gecko || browser.safari) && anchor == head) {
      let {node, offset} = anchorDOM
      if (node.nodeType == 3) {
        brKludge = !!(offset && node.nodeValue![offset - 1] == "\n")
        // Issue #1128
        if (brKludge && offset == node.nodeValue!.length) {
          for (let scan: DOMNode | null = node, after; scan; scan = scan.parentNode) {
            if (after = scan.nextSibling) {
              if (after.nodeName == "BR")
                anchorDOM = headDOM = {node: after.parentNode!, offset: domIndex(after) + 1}
              break
            }
            let desc = scan.pmViewDesc
            if (desc && desc.node && desc.node.isBlock) break
          }
        }
      } else {
        let prev = node.childNodes[offset - 1]
        brKludge = prev && (prev.nodeName == "BR" || (prev as HTMLElement).contentEditable == "false")
      }
    }
    // Firefox can act strangely when the selection is in front of an
    // uneditable node. See #1163 and https://bugzilla.mozilla.org/show_bug.cgi?id=1709536
    if (browser.gecko && domSel.focusNode && domSel.focusNode != headDOM.node && domSel.focusNode.nodeType == 1) {
      let after = domSel.focusNode.childNodes[domSel.focusOffset]
      if (after && (after as HTMLElement).contentEditable == "false") force = true
    }

    if (!(force || brKludge && browser.safari) &&
        isEquivalentPosition(anchorDOM.node, anchorDOM.offset, domSel.anchorNode!, domSel.anchorOffset) &&
        isEquivalentPosition(headDOM.node, headDOM.offset, domSel.focusNode!, domSel.focusOffset))
      return

    // Selection.extend can be used to create an 'inverted' selection
    // (one where the focus is before the anchor), but not all
    // browsers support it yet.
    let domSelExtended = false
    if ((domSel.extend || anchor == head) && !brKludge) {
      const { node, offset } = anchorDOM.node.pmViewDesc ? anchorDOM.node.pmViewDesc.getSelectedTarget(anchorDOM.node, anchorDOM.offset) : anchorDOM;
      domSel.collapse(node, offset)
      try {
        if (anchor != head) {
          const { node, offset } = headDOM.node.pmViewDesc ? headDOM.node.pmViewDesc.getSelectedTarget(headDOM.node, headDOM.offset) : headDOM;
          domSel.extend(node, offset)
        }
        domSelExtended = true
      } catch (_) {
        // In some cases with Chrome the selection is empty after calling
        // collapse, even when it should be valid. This appears to be a bug, but
        // it is difficult to isolate. If this happens fallback to the old path
        // without using extend.
        // Similarly, this could crash on Safari if the editor is hidden, and
        // there was no selection.
      }
    }
    if (!domSelExtended) {
      if (anchor > head) { let tmp = anchorDOM; anchorDOM = headDOM; headDOM = tmp }
      let range = document.createRange()
      range.setEnd(headDOM.node, headDOM.offset)
      range.setStart(anchorDOM.node, anchorDOM.offset)
      domSel.removeAllRanges()
      domSel.addRange(range)
    }
  }

  ignoreMutation(mutation: MutationRecord): boolean {
    return !this.contentDOM && (mutation.type as any) != "selection"
  }

  get contentLost() {
    return this.contentDOM && this.contentDOM != this.dom && !this.dom.contains(this.contentDOM)
  }

  // Remove a subtree of the element tree that has been touched
  // by a DOM change, so that the next update will redraw it.
  markDirty(from: number, to: number) {
    for (let offset = 0, i = 0; i < this.children.length; i++) {
      let child = this.children[i], end = offset + child.size
      if (offset == end ? from <= end && to >= offset : from < end && to > offset) {
        let startInside = offset + child.border, endInside = end - child.border
        if (from >= startInside && to <= endInside) {
          this.dirty = from == offset || to == end ? CONTENT_DIRTY : CHILD_DIRTY
          if (from == startInside && to == endInside &&
              (child.contentLost || child.dom.parentNode != this.contentDOM)) child.dirty = NODE_DIRTY
          else child.markDirty(from - startInside, to - startInside)
          return
        } else {
          child.dirty = child.dom == child.contentDOM && child.dom.parentNode == this.contentDOM && !child.children.length
            ? CONTENT_DIRTY : NODE_DIRTY
        }
      }
      offset = end
    }
    this.dirty = CONTENT_DIRTY
  }

  markParentsDirty() {
    let level = 1
    for (let node = this.parent; node; node = node.parent, level++) {
      let dirty = level == 1 ? CONTENT_DIRTY : CHILD_DIRTY
      if (node.dirty < dirty) node.dirty = dirty
    }
  }

  get domAtom() { return false }

  get ignoreForCoords() { return false }
}

const WIDGET_LAYOUT_INFO: ILayoutInfo = {
  isDirty: false,
  height: 0,
  marginTop: 0,
  marginBottom: 0,
  offsetTopToParent: 0,
};

// A widget desc represents a widget decoration, which is a DOM node
// drawn between the document nodes.
class WidgetViewDesc extends ViewDesc {
  constructor(parent: ViewDesc, readonly widget: Decoration, view: EditorView, pos: number) {
    let self: WidgetViewDesc, dom = (widget.type as any).toDOM as WidgetConstructor
    if (typeof dom == "function") dom = dom(view, () => {
      if (!self) return pos
      if (self.parent) return self.parent.posBeforeChild(self)
    })
    if (!widget.type.spec.raw) {
      if (dom.nodeType != 1) {
        let wrap = document.createElement("span")
        wrap.appendChild(dom)
        dom = wrap
      }
      ;(dom as HTMLElement).contentEditable = "false"
      ;(dom as HTMLElement).classList.add("ProseMirror-widget")
    }
    super(parent, [], dom, null)
    this.widget = widget
    this.keep = true
    this.layoutInfo = WIDGET_LAYOUT_INFO;
    self = this
  }

  matchesWidget(widget: Decoration) {
    return this.dirty == NOT_DIRTY && widget.type.eq(this.widget.type)
  }

  parseRule() { return {ignore: true} }

  stopEvent(event: Event) {
    let stop = this.widget.spec.stopEvent
    return stop ? stop(event) : false
  }

  ignoreMutation(mutation: MutationRecord) {
    return (mutation.type as any) != "selection" || this.widget.spec.ignoreSelection
  }

  destroy() {
    this.widget.type.destroy(this.dom)
    super.destroy()
  }

  get domAtom() { return true }

  get side() { return (this.widget.type as any).side as number }
}

class CompositionViewDesc extends ViewDesc {
  constructor(parent: ViewDesc, dom: DOMNode, readonly textDOM: Text, readonly text: string) {
    super(parent, [], dom, null)
  }

  get size() { return this.text.length }

  localPosFromDOM(dom: DOMNode, offset: number) {
    if (dom != this.textDOM) return this.posAtStart + (offset ? this.size : 0)
    return this.posAtStart + offset
  }

  domFromPos(pos: number) {
    return {node: this.textDOM, offset: pos}
  }

  ignoreMutation(mut: MutationRecord) {
    return mut.type === 'characterData' && mut.target.nodeValue == mut.oldValue
   }
}

// A mark desc represents a mark. May have multiple children,
// depending on how the mark is split. Note that marks are drawn using
// a fixed nesting order, for simplicity and predictability, so in
// some cases they will be split more often than would appear
// necessary.
class MarkViewDesc extends ViewDesc {
  constructor(parent: ViewDesc, readonly mark: Mark, dom: DOMNode, contentDOM: HTMLElement) {
    super(parent, [], dom, contentDOM)
  }

  static create(parent: ViewDesc, mark: Mark, inline: boolean, view: EditorView) {
    let custom = view.nodeViews[mark.type.name]
    let spec: {dom: HTMLElement, contentDOM?: HTMLElement} = custom && (custom as any)(mark, view, inline)
    if (!spec || !spec.dom)
      spec = DOMSerializer.renderSpec(document, mark.type.spec.toDOM!(mark, inline)) as any
    return new MarkViewDesc(parent, mark, spec.dom, spec.contentDOM || spec.dom as HTMLElement)
  }

  parseRule(): ParseRule | null {
    if ((this.dirty & NODE_DIRTY) || this.mark.type.spec.reparseInView) return null
    return {mark: this.mark.type.name, attrs: this.mark.attrs, contentElement: this.contentDOM!}
  }

  matchesMark(mark: Mark) { return this.dirty != NODE_DIRTY && this.mark.eq(mark) }

  markDirty(from: number, to: number) {
    super.markDirty(from, to)
    // Move dirty info to nearest node view
    if (this.dirty != NOT_DIRTY) {
      let parent = this.parent!
      while (!parent.node) parent = parent.parent!
      if (parent.dirty < this.dirty) parent.dirty = this.dirty
      this.dirty = NOT_DIRTY
    }
  }

  slice(from: number, to: number, view: EditorView) {
    let copy = MarkViewDesc.create(this.parent!, this.mark, true, view)
    let nodes = this.children, size = this.size
    if (to < size) nodes = replaceNodes(nodes, to, size, view)
    if (from > 0) nodes = replaceNodes(nodes, 0, from, view)
    for (let i = 0; i < nodes.length; i++) nodes[i].parent = copy
    copy.children = nodes
    return copy
  }
}

// Node view descs are the main, most common type of view desc, and
// correspond to an actual node in the document. Unlike mark descs,
// they populate their child array themselves.
export class NodeViewDesc extends ViewDesc {
  constructor(
    parent: ViewDesc | undefined,
    public node: Node,
    public outerDeco: readonly Decoration[],
    public innerDeco: DecorationSource,
    dom: DOMNode,
    contentDOM: HTMLElement | null,
    readonly nodeDOM: DOMNode,
    view: EditorView,
    pos: number,
    isRoot?: boolean
  ) {
    super(parent, [], dom, contentDOM, isRoot)
  }

  // By default, a node is rendered using the `toDOM` method from the
  // node type spec. But client code can use the `nodeViews` spec to
  // supply a custom node view, which can influence various aspects of
  // the way the node works.
  //
  // (Using subclassing for this was intentionally decided against,
  // since it'd require exposing a whole slew of finicky
  // implementation details to the user code that they probably will
  // never need.)
  static create(parent: ViewDesc | undefined, node: Node, outerDeco: readonly Decoration[],
                innerDeco: DecorationSource, view: EditorView, pos: number, fake = false) {
    const parentNodeViewDesc = getParentNodeViewDesc(parent);
    if (fake && (parentNodeViewDesc?.isRoot || !parentNodeViewDesc?.isRendered)) {
      return new FakeNodeViewDesc(parent, node, outerDeco, innerDeco, view, pos + 1)
    }

    let custom = view.nodeViews[node.type.name], descObj: ViewDesc
    let spec: NodeView | undefined = custom && (custom as any)(node, view, () => {
      // (This is a function that allows the custom view to find its
      // own position)
      if (!descObj) return pos
      if (descObj.parent) return descObj.parent.posBeforeChild(descObj)
    }, outerDeco, innerDeco)

    let dom = spec && spec.dom, contentDOM = spec && spec.contentDOM
    if (node.isText) {
      if (!dom) dom = document.createTextNode(node.text!)
      else if (dom.nodeType != 3) throw new RangeError("Text must be rendered as a DOM text node")
    } else if (!dom) {
      ;({dom, contentDOM} = DOMSerializer.renderSpec(document, node.type.spec.toDOM!(node)))
    }
    if (!contentDOM && !node.isText && dom.nodeName != "BR") { // Chrome gets confused by <br contenteditable=false>
      if (!(dom as HTMLElement).hasAttribute("contenteditable")) (dom as HTMLElement).contentEditable = "false"
      if (node.type.spec.draggable) (dom as HTMLElement).draggable = true
    }

    let nodeDOM = dom
    dom = applyOuterDeco(dom, outerDeco, node)

    if (spec)
      return descObj = new CustomNodeViewDesc(parent, node, outerDeco, innerDeco, dom, contentDOM || null, nodeDOM,
                                              spec, view, pos + 1)
    else if (node.isText)
      return new TextViewDesc(parent, node, outerDeco, innerDeco, dom, nodeDOM, view)
    else
      return new NodeViewDesc(parent, node, outerDeco, innerDeco, dom, contentDOM || null, nodeDOM, view, pos + 1)
  }

  parseRule(): ParseRule | null {
    // Experimental kludge to allow opt-in re-parsing of nodes
    if (this.node.type.spec.reparseInView) return null
    // FIXME the assumption that this can always return the current
    // attrs means that if the user somehow manages to change the
    // attrs in the dom, that won't be picked up. Not entirely sure
    // whether this is a problem
    let rule: ParseRule = {node: this.node.type.name, attrs: this.node.attrs}
    if (this.node.type.whitespace == "pre") rule.preserveWhitespace = "full"
    if (!this.contentDOM) {
      rule.getContent = () => this.node.content
    } else if (!this.contentLost) {
      rule.contentElement = this.contentDOM
    } else {
      // Chrome likes to randomly recreate parent nodes when
      // backspacing things. When that happens, this tries to find the
      // new parent.
      for (let i = this.children.length - 1; i >= 0; i--) {
        let child = this.children[i]
        if (this.dom.contains(child.dom.parentNode)) {
          rule.contentElement = child.dom.parentNode as HTMLElement
          break
        }
      }
      if (!rule.contentElement) rule.getContent = () => Fragment.empty
    }
    return rule
  }

  matchesNode(node: Node, outerDeco: readonly Decoration[], innerDeco: DecorationSource) {
    return this.dirty == NOT_DIRTY && node.eq(this.node) &&
      sameOuterDeco(outerDeco, this.outerDeco) && innerDeco.eq(this.innerDeco)
  }

  get size() { return this.node.nodeSize }

  get border() { return this.node.isLeaf ? 0 : 1 }

  // Syncs `this.children` to match `this.node.content` and the local
  // decorations, possibly introducing nesting for marks. Then, in a
  // separate step, syncs the DOM inside `this.contentDOM` to
  // `this.children`.
  updateChildren(view: EditorView, pos: number, fake = true) {
    let inline = this.node.inlineContent, off = pos
    let composition = view.composing ? this.localCompositionInfo(view, pos) : null
    let localComposition = composition && composition.pos > -1 ? composition : null
    let compositionInChild = composition && composition.pos < 0
    let updater = new ViewTreeUpdater(this, localComposition && localComposition.node, view)
    iterDeco(this.node, this.innerDeco, (widget, i, insideNode) => {
      if (widget.spec.marks)
        updater.syncToMarks(widget.spec.marks, inline, view)
      else if ((widget.type as WidgetType).side >= 0 && !insideNode)
        updater.syncToMarks(i == this.node.childCount ? Mark.none : this.node.child(i).marks, inline, view)
      // If the next node is a desc matching this widget, reuse it,
      // otherwise insert the widget as a new view desc.
      updater.placeWidget(widget, view, off)
    }, (child, outerDeco, innerDeco, i) => {
      // Make sure the wrapping mark descs match the node's marks.
      updater.syncToMarks(child.marks, inline, view)
      // Try several strategies for drawing this node
      let compIndex
      if (fake && updater.findNodeMatch(child, outerDeco, innerDeco, i)) {
        // Found precise match with existing node view
      } else if (compositionInChild && view.state.selection.from > off &&
                 view.state.selection.to < off + child.nodeSize &&
                 (compIndex = updater.findIndexWithChild(composition!.node)) > -1 &&
                 updater.updateNodeAt(child, outerDeco, innerDeco, compIndex, view)) {
        // Updated the specific node that holds the composition
      } else if (updater.updateNextNode(child, outerDeco, innerDeco, view, i, off)) {
        // Could update an existing node to reflect this node
      } else {
        // Add it as a new view
        updater.addNode(child, outerDeco, innerDeco, view, off, fake)
      }
      off += child.nodeSize
    })
    // Drop all remaining descs after the current position.
    updater.syncToMarks([], inline, view)
    if (this.node.isTextblock && this.isRendered) updater.addTextblockHacks()
    updater.destroyRest()

    // Sync the DOM if anything changed
    if (updater.changed || this.dirty == CONTENT_DIRTY) {
      this.markLayoutDirty();
      // May have to protect focused DOM from being changed if a composition is active
      if (localComposition) this.protectLocalComposition(view, localComposition)
      this.node.isTextblock && this.isRendered && renderDescs(this.contentDOM!, this.children, view)
      if (browser.ios) iosHacks(this.dom as HTMLElement)
    }
  }

  localCompositionInfo(view: EditorView, pos: number): {node: Text, pos: number, text: string} | null {
    // Only do something if both the selection and a focused text node
    // are inside of this node
    let {from, to} = view.state.selection
    if (!(view.state.selection instanceof TextSelection) || from < pos || to > pos + this.node.content.size) return null
    let sel = view.domSelectionRange()
    let textNode = nearbyTextNode(sel.focusNode!, sel.focusOffset)
    if (!textNode || !this.dom.contains(textNode.parentNode)) return null

    if (this.node.inlineContent) {
      // Find the text in the focused node in the node, stop if it's not
      // there (may have been modified through other means, in which
      // case it should overwritten)
      let text = textNode.nodeValue!
      let textPos = findTextInFragment(this.node.content, text, from - pos, to - pos)
      return textPos < 0 ? null : {node: textNode, pos: textPos, text}
    } else {
      return {node: textNode, pos: -1, text: ""}
    }
  }

  protectLocalComposition(view: EditorView, {node, pos, text}: {node: Text, pos: number, text: string}) {
    // The node is already part of a local view desc, leave it there
    if (this.getDesc(node)) return

    // Create a composition view for the orphaned nodes
    let topNode: DOMNode = node
    for (;; topNode = topNode.parentNode!) {
      if (topNode.parentNode == this.contentDOM) break
      while (topNode.previousSibling) topNode.parentNode!.removeChild(topNode.previousSibling)
      while (topNode.nextSibling) topNode.parentNode!.removeChild(topNode.nextSibling)
      if (topNode.pmViewDesc) topNode.pmViewDesc = undefined
    }
    let desc = new CompositionViewDesc(this, topNode, node, text)
    view.input.compositionNodes.push(desc)

    // Patch up this.children to contain the composition view
    this.children = replaceNodes(this.children, pos, pos + text.length, view, desc)
  }

  // If this desc must be updated to match the given node decoration,
  // do so and return true.
  update(node: Node, outerDeco: readonly Decoration[], innerDeco: DecorationSource, view: EditorView) {
    if (this.dirty == NODE_DIRTY ||
        !node.sameMarkup(this.node)) return false
    this.updateInner(node, outerDeco, innerDeco, view)
    this.markLayoutDirty();
    return true
  }

  updateInner(node: Node, outerDeco: readonly Decoration[], innerDeco: DecorationSource, view: EditorView) {
    this.updateOuterDeco(outerDeco)
    this.node = node
    this.innerDeco = innerDeco
    if (this.contentDOM) this.updateChildren(view, this.posAtStart)
    this.dirty = NOT_DIRTY
  }

  updateOuterDeco(outerDeco: readonly Decoration[]) {
    if (sameOuterDeco(outerDeco, this.outerDeco)) return
    let needsWrap = this.nodeDOM.nodeType != 1
    let oldDOM = this.dom
    this.dom = patchOuterDeco(this.dom, this.nodeDOM,
                              computeOuterDeco(this.outerDeco, this.node, needsWrap),
                              computeOuterDeco(outerDeco, this.node, needsWrap))
    if (this.dom != oldDOM) {
      oldDOM.pmViewDesc = undefined
      this.dom.pmViewDesc = this
    }
    this.outerDeco = outerDeco
  }

  // Mark this node as being the selected node.
  selectNode() {
    if (this.nodeDOM.nodeType == 1) (this.nodeDOM as HTMLElement).classList.add("ProseMirror-selectednode")
    if (this.contentDOM || !this.node.type.spec.draggable) (this.dom as HTMLElement).draggable = true
  }

  // Remove selected node marking from this node.
  deselectNode() {
    if (this.nodeDOM.nodeType == 1) (this.nodeDOM as HTMLElement).classList.remove("ProseMirror-selectednode")
    if (this.contentDOM || !this.node.type.spec.draggable) (this.dom as HTMLElement).removeAttribute("draggable")
  }

  get domAtom() { return this.node.isAtom }
}

// Create a view desc for the top-level document node, to be exported
// and used by the view class.
export function docViewDesc(doc: Node, outerDeco: readonly Decoration[], innerDeco: DecorationSource,
                            dom: HTMLElement, view: EditorView): NodeViewDesc {
  applyOuterDeco(dom, outerDeco, doc)
  let docView = new NodeViewDesc(undefined, doc, outerDeco, innerDeco, dom, dom, dom, view, 0, true)
  if (docView.contentDOM) docView.updateChildren(view, 0)
  return docView
}

class TextViewDesc extends NodeViewDesc {
  constructor(parent: ViewDesc | undefined, node: Node, outerDeco: readonly Decoration[],
              innerDeco: DecorationSource, dom: DOMNode, nodeDOM: DOMNode, view: EditorView) {
    super(parent, node, outerDeco, innerDeco, dom, null, nodeDOM, view, 0)
  }

  parseRule(): ParseRule {
    let skip = this.nodeDOM.parentNode
    while (skip && skip != this.dom && !(skip as any).pmIsDeco) skip = skip.parentNode
    return {skip: (skip || true) as any}
  }

  update(node: Node, outerDeco: readonly Decoration[], innerDeco: DecorationSource, view: EditorView) {
    if (this.dirty == NODE_DIRTY || (this.dirty != NOT_DIRTY && !this.inParent()) ||
        !node.sameMarkup(this.node)) return false
    this.updateOuterDeco(outerDeco)
    view.trackSkipUpdate = node.text === this.nodeDOM.nodeValue;
    if ((this.dirty != NOT_DIRTY || node.text != this.node.text) && node.text != this.nodeDOM.nodeValue) {
      this.nodeDOM.nodeValue = node.text!
      if (view.trackWrites == this.nodeDOM) view.trackWrites = null
    }
    this.node = node
    this.dirty = NOT_DIRTY
    return true
  }

  inParent() {
    let parentDOM = this.parent!.contentDOM
    for (let n: DOMNode | null = this.nodeDOM; n; n = n.parentNode) if (n == parentDOM) return true
    return false
  }

  domFromPos(pos: number) {
    return {node: this.nodeDOM, offset: pos}
  }

  localPosFromDOM(dom: DOMNode, offset: number, bias: number) {
    if (dom == this.nodeDOM) return this.posAtStart + Math.min(offset, this.node.text!.length)
    return super.localPosFromDOM(dom, offset, bias)
  }

  ignoreMutation(mutation: MutationRecord) {
    return mutation.type != "characterData" && (mutation.type as any) != "selection"
  }

  slice(from: number, to: number, view: EditorView) {
    let node = this.node.cut(from, to), dom = document.createTextNode(node.text!)
    return new TextViewDesc(this.parent, node, this.outerDeco, this.innerDeco, dom, dom, view)
  }

  markDirty(from: number, to: number) {
    super.markDirty(from, to)
    if (this.dom != this.nodeDOM && (from == 0 || to == this.nodeDOM.nodeValue!.length))
      this.dirty = NODE_DIRTY
  }

  get domAtom() { return false }
}

// A dummy desc used to tag trailing BR or IMG nodes created to work
// around contentEditable terribleness.
class TrailingHackViewDesc extends ViewDesc {
  parseRule() { return {ignore: true} }
  matchesHack(nodeName: string) { return this.dirty == NOT_DIRTY && this.dom.nodeName == nodeName }
  get domAtom() { return true }
  get ignoreForCoords() { return this.dom.nodeName == "IMG" }
}

// const DEFAULT_FAKE_DOM = document.createElement('div');
class FakeNodeViewDesc extends NodeViewDesc {
  dom: HTMLElement;

  constructor(parent: ViewDesc | undefined, node: Node, outerDeco: readonly Decoration[], innerDeco: DecorationSource,
    view: EditorView, pos: number) {
      // 暂时不能用 DEFAULT_FAKE_DOM，因为 dom 与 ViewDesc 存在关联关系
      const dom = document.createElement('div');
      super(parent, node, outerDeco, innerDeco, dom, dom, dom, view, pos)
      this.dom = dom;
      this.isRendered = false;
  }

  render(view: EditorView, pos: number) {
    const node = NodeViewDesc.create(this.parent, this.node, this.outerDeco, this.innerDeco, view, pos);

    if (this.parent?.viewportNodes.has(this)) {
      this.parent.viewportNodes.add(node);
      this.parent.viewportNodes.delete(this);
    }

    if (this.parent?.bufferNodes.upward.has(this)) {
      this.parent.bufferNodes.upward.add(node);
      this.parent.bufferNodes.upward.delete(this);
    }

    if (this.parent?.bufferNodes.downward.has(this)) {
      this.parent.bufferNodes.downward.add(node);
      this.parent.bufferNodes.downward.delete(this);
    }

    return node;
  }

  update(node: Node, outerDeco: readonly Decoration[], innerDeco: DecorationSource, view: EditorView): boolean {
    // do nothing
    return false;
  }

  selectNode() {
    console.error(`Can't select a fake node view`, this);
  }

  deselectNode() {
    console.error(`Can't deselect a fake node view`, this);
  }

  setSelection() {
    console.error(`Can't set selection on a fake node view`, this);
  }

  destroy() {
    super.destroy()
  }

  ignoreMutation() {
    return true;
  }
}
// A separate subclass is used for customized node views, so that the
// extra checks only have to be made for nodes that are actually
// customized.
class CustomNodeViewDesc extends NodeViewDesc {
  constructor(parent: ViewDesc | undefined, node: Node, outerDeco: readonly Decoration[], innerDeco: DecorationSource,
              dom: DOMNode, contentDOM: HTMLElement | null, nodeDOM: DOMNode, readonly spec: NodeView,
              view: EditorView, pos: number) {
    super(parent, node, outerDeco, innerDeco, dom, contentDOM, nodeDOM, view, pos)
  }

  // A custom `update` method gets to decide whether the update goes
  // through. If it does, and there's a `contentDOM` node, our logic
  // updates the children.
  update(node: Node, outerDeco: readonly Decoration[], innerDeco: DecorationSource, view: EditorView) {
    if (this.dirty == NODE_DIRTY) return false
    if (this.spec.update) {
      let result = this.spec.update(node, outerDeco, innerDeco)
      if (result) this.updateInner(node, outerDeco, innerDeco, view)
      return result
    } else if (!this.contentDOM && !node.isLeaf) {
      return false
    } else {
      return super.update(node, outerDeco, innerDeco, view)
    }
  }

  selectNode() {
    this.spec.selectNode ? this.spec.selectNode() : super.selectNode()
  }

  deselectNode() {
    this.spec.deselectNode ? this.spec.deselectNode() : super.deselectNode()
  }

  setSelection(anchor: number, head: number, root: Document | ShadowRoot, force: boolean) {
    this.spec.setSelection ? this.spec.setSelection(anchor, head, root)
      : super.setSelection(anchor, head, root, force)
  }

  destroy() {
    if (this.spec.destroy) this.spec.destroy()
    super.destroy()
  }

  stopEvent(event: Event) {
    return this.spec.stopEvent ? this.spec.stopEvent(event) : false
  }

  ignoreMutation(mutation: MutationRecord) {
    return this.spec.ignoreMutation ? this.spec.ignoreMutation(mutation) : super.ignoreMutation(mutation)
  }
}

// Sync the content of the given DOM node with the nodes associated
// with the given array of view descs, recursing into mark descs
// because this should sync the subtree for a whole node at a time.
function renderDescs(parentDOM: HTMLElement, descs: readonly (ViewDescRenderer|PlaceholderInfo)[], view?: EditorView) {
  let dom = parentDOM.firstChild, written = false
  for (let i = 0; i < descs.length; i++) {
    let desc = descs[i], childDOM = desc.dom
    if (dom && childDOM.parentNode == parentDOM) {
      while (childDOM != dom) { dom = rm(dom!); written = true }
      dom = dom.nextSibling
    } else {
      written = true
      parentDOM.insertBefore(childDOM, dom)
    }
    if (desc instanceof MarkViewDesc) {
      let pos = dom ? dom.previousSibling : parentDOM.lastChild
      renderDescs(desc.contentDOM!, desc.children, view)
      dom = pos ? pos.nextSibling : parentDOM.firstChild
    }
  }
  while (dom) { dom = rm(dom); written = true }
  if (view && written && view.trackWrites == parentDOM) view.trackWrites = null
}

type OuterDecoLevel = {[attr: string]: string}

const OuterDecoLevel: {new (nodeName?: string): OuterDecoLevel} = function(this: any, nodeName?: string) {
  if (nodeName) this.nodeName = nodeName
} as any
OuterDecoLevel.prototype = Object.create(null)

const noDeco = [new OuterDecoLevel]

function computeOuterDeco(outerDeco: readonly Decoration[], node: Node, needsWrap: boolean) {
  if (outerDeco.length == 0) return noDeco

  let top = needsWrap ? noDeco[0] : new OuterDecoLevel, result = [top]

  for (let i = 0; i < outerDeco.length; i++) {
    let attrs = (outerDeco[i].type as NodeType).attrs
    if (!attrs) continue
    if (attrs.nodeName)
      result.push(top = new OuterDecoLevel(attrs.nodeName))

    for (let name in attrs) {
      let val = attrs[name]
      if (val == null) continue
      if (needsWrap && result.length == 1)
        result.push(top = new OuterDecoLevel(node.isInline ? "span" : "div"))
      if (name == "class") top.class = (top.class ? top.class + " " : "") + val
      else if (name == "style") top.style = (top.style ? top.style + ";" : "") + val
      else if (name != "nodeName") top[name] = val
    }
  }

  return result
}

function patchOuterDeco(outerDOM: DOMNode, nodeDOM: DOMNode,
                        prevComputed: readonly OuterDecoLevel[], curComputed: readonly OuterDecoLevel[]) {
  // Shortcut for trivial case
  if (prevComputed == noDeco && curComputed == noDeco) return nodeDOM

  let curDOM = nodeDOM
  for (let i = 0; i < curComputed.length; i++) {
    let deco = curComputed[i], prev = prevComputed[i]
    if (i) {
      let parent: DOMNode | null
      if (prev && prev.nodeName == deco.nodeName && curDOM != outerDOM &&
          (parent = curDOM.parentNode) && parent.nodeName!.toLowerCase() == deco.nodeName) {
        curDOM = parent
      } else {
        parent = document.createElement(deco.nodeName)
        ;(parent as any).pmIsDeco = true
        parent.appendChild(curDOM)
        prev = noDeco[0]
        curDOM = parent
      }
    }
    patchAttributes(curDOM as HTMLElement, prev || noDeco[0], deco)
  }
  return curDOM
}

function patchAttributes(dom: HTMLElement, prev: {[name: string]: string}, cur: {[name: string]: string}) {
  for (let name in prev)
    if (name != "class" && name != "style" && name != "nodeName" && !(name in cur))
      dom.removeAttribute(name)
  for (let name in cur)
    if (name != "class" && name != "style" && name != "nodeName" && cur[name] != prev[name])
      dom.setAttribute(name, cur[name])
  if (prev.class != cur.class) {
    let prevList = prev.class ? prev.class.split(" ").filter(Boolean) : []
    let curList = cur.class ? cur.class.split(" ").filter(Boolean) : []
    for (let i = 0; i < prevList.length; i++) if (curList.indexOf(prevList[i]) == -1)
      dom.classList.remove(prevList[i])
    for (let i = 0; i < curList.length; i++) if (prevList.indexOf(curList[i]) == -1)
      dom.classList.add(curList[i])
    if (dom.classList.length == 0)
      dom.removeAttribute("class")
  }
  if (prev.style != cur.style) {
    if (prev.style) {
      let prop = /\s*([\w\-\xa1-\uffff]+)\s*:(?:"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|\(.*?\)|[^;])*/g, m
      while (m = prop.exec(prev.style))
        dom.style.removeProperty(m[1])
    }
    if (cur.style)
      dom.style.cssText += cur.style
  }
}

function applyOuterDeco(dom: DOMNode, deco: readonly Decoration[], node: Node) {
  return patchOuterDeco(dom, dom, noDeco, computeOuterDeco(deco, node, dom.nodeType != 1))
}

function sameOuterDeco(a: readonly Decoration[], b: readonly Decoration[]) {
  if (a.length != b.length) return false
  for (let i = 0; i < a.length; i++) if (!a[i].type.eq(b[i].type)) return false
  return true
}

// Remove a DOM node and return its next sibling.
function rm(dom: DOMNode) {
  let next = dom.nextSibling
  dom.parentNode!.removeChild(dom)
  return next
}

// Helper class for incrementally updating a tree of mark descs and
// the widget and node descs inside of them.
class ViewTreeUpdater {
  // Index into `this.top`'s child array, represents the current
  // update position.
  index = 0
  // When entering a mark, the current top and index are pushed
  // onto this.
  stack: (ViewDesc | number)[] = []
  // Tracks whether anything was changed
  changed = false
  preMatch: {index: number, matched: Map<ViewDesc, number>, matches: readonly ViewDesc[]}
  top: ViewDesc

  constructor(top: NodeViewDesc, readonly lock: DOMNode | null, private readonly view: EditorView) {
    this.top = top
    this.preMatch = preMatch(top.node.content, top)
  }

  // Destroy and remove the children between the given indices in
  // `this.top`.
  destroyBetween(start: number, end: number) {
    if (start == end) return
    for (let i = start; i < end; i++) this.top.children[i].destroy()
    this.top.children.splice(start, end - start)
    this.changed = true
  }

  // Destroy all remaining children in `this.top`.
  destroyRest() {
    this.destroyBetween(this.index, this.top.children.length)
  }

  // Sync the current stack of mark descs with the given array of
  // marks, reusing existing mark descs when possible.
  syncToMarks(marks: readonly Mark[], inline: boolean, view: EditorView) {
    let keep = 0, depth = this.stack.length >> 1
    let maxKeep = Math.min(depth, marks.length)
    while (keep < maxKeep &&
           (keep == depth - 1 ? this.top : this.stack[(keep + 1) << 1] as ViewDesc)
             .matchesMark(marks[keep]) && marks[keep].type.spec.spanning !== false)
      keep++

    while (keep < depth) {
      this.destroyRest()
      this.top.dirty = NOT_DIRTY
      this.index = this.stack.pop() as number
      this.top = this.stack.pop() as ViewDesc
      depth--
    }
    while (depth < marks.length) {
      this.stack.push(this.top, this.index + 1)
      let found = -1
      for (let i = this.index; i < Math.min(this.index + 3, this.top.children.length); i++) {
        let next = this.top.children[i]
        if (next.matchesMark(marks[depth]) && !this.isLocked(next.dom)) { found = i; break }
      }
      if (found > -1) {
        if (found > this.index) {
          this.changed = true
          this.destroyBetween(this.index, found)
        }
        this.top = this.top.children[this.index]
      } else {
        let markDesc = MarkViewDesc.create(this.top, marks[depth], inline, view)
        this.top.children.splice(this.index, 0, markDesc)
        this.top = markDesc
        this.changed = true
      }
      this.index = 0
      depth++
    }
  }

  // Try to find a node desc matching the given data. Skip over it and
  // return true when successful.
  findNodeMatch(node: Node, outerDeco: readonly Decoration[], innerDeco: DecorationSource, index: number): boolean {
    let found = -1, targetDesc
    if (index >= this.preMatch.index &&
        (targetDesc = this.preMatch.matches[index - this.preMatch.index]).parent == this.top &&
        targetDesc.matchesNode(node, outerDeco, innerDeco)) {
      found = this.top.children.indexOf(targetDesc, this.index)
    } else {
      for (let i = this.index, e = Math.min(this.top.children.length, i + 5); i < e; i++) {
        let child = this.top.children[i]
        if (child.matchesNode(node, outerDeco, innerDeco) && !this.preMatch.matched.has(child)) {
          found = i
          if (child.node !== node) child.node = node;
          break
        }
      }
    }
    if (found < 0) return false
    this.destroyBetween(this.index, found)
    this.index++
    return true
  }

  updateNodeAt(node: Node, outerDeco: readonly Decoration[], innerDeco: DecorationSource, index: number, view: EditorView) {
    let child = this.top.children[index] as NodeViewDesc
    if (child.dirty == NODE_DIRTY && child.dom == child.contentDOM) child.dirty = CONTENT_DIRTY
    if (!child.update(node, outerDeco, innerDeco, view)) return false
    this.destroyBetween(this.index, index)
    this.index++
    return true
  }

  findIndexWithChild(domNode: DOMNode) {
    for (;;) {
      let parent = domNode.parentNode
      if (!parent) return -1
      if (parent == this.top.contentDOM) {
        let desc = domNode.pmViewDesc
        if (desc) for (let i = this.index; i < this.top.children.length; i++) {
          if (this.top.children[i] == desc) return i
        }
        return -1
      }
      domNode = parent
    }
  }

  // Try to update the next node, if any, to the given data. Checks
  // pre-matches to avoid overwriting nodes that could still be used.
  updateNextNode(node: Node, outerDeco: readonly Decoration[], innerDeco: DecorationSource,
                 view: EditorView, index: number, pos: number): boolean {
    for (let i = this.index; i < this.top.children.length; i++) {
      let next = this.top.children[i]
      if (next instanceof NodeViewDesc) {
        let preMatch = this.preMatch.matched.get(next)
        if (preMatch != null && preMatch != index) return false
        let nextDOM = next.dom, updated

        // Can't update if nextDOM is or contains this.lock, except if
        // it's a text node whose content already matches the new text
        // and whose decorations match the new ones.
        let locked = this.isLocked(nextDOM) &&
            !(node.isText && next.node && next.node.isText && next.nodeDOM.nodeValue == node.text &&
              next.dirty != NODE_DIRTY && sameOuterDeco(outerDeco, next.outerDeco))
        if (!locked && next.update(node, outerDeco, innerDeco, view)) {
          this.destroyBetween(this.index, i)
          if (next.dom != nextDOM) this.changed = true
          this.index++
          return true
          // TODO:
        } else if (!locked && (updated = this.recreateWrapper(next, node, outerDeco, innerDeco, view, pos))) {
          this.top.children[this.index] = updated
          updated.dirty = CONTENT_DIRTY
          updated.updateChildren(view, pos + 1)
          updated.dirty = NOT_DIRTY
          this.changed = true
          this.index++
          return true
        }
        break
      }
    }
    return false
  }

  // When a node with content is replaced by a different node with
  // identical content, move over its children.
  recreateWrapper(next: NodeViewDesc, node: Node, outerDeco: readonly Decoration[], innerDeco: DecorationSource,
                  view: EditorView, pos: number) {
    if (next.dirty || node.isAtom || !next.children.length ||
        !next.node.content.eq(node.content)) return null
    let wrapper = NodeViewDesc.create(this.top, node, outerDeco, innerDeco, view, pos)
    if (!wrapper.contentDOM) return null
    wrapper.children = next.children
    next.children = []
    next.destroy()
    for (let ch of wrapper.children) ch.parent = wrapper

    return wrapper
  }

  // Insert the node as a newly created node desc.
  addNode(node: Node, outerDeco: readonly Decoration[], innerDeco: DecorationSource, view: EditorView, pos: number, fake: boolean) {
    let desc = NodeViewDesc.create(this.top, node, outerDeco, innerDeco, view, pos, fake)
    if (desc.contentDOM) desc.updateChildren(view, pos + 1)
    this.top.children.splice(this.index++, 0, desc)
    this.changed = true
  }

  placeWidget(widget: Decoration, view: EditorView, pos: number) {
    let next = this.index < this.top.children.length ? this.top.children[this.index] : null
    if (next && next.matchesWidget(widget) &&
        (widget == (next as WidgetViewDesc).widget || !(next as any).widget.type.toDOM.parentNode)) {
      this.index++
    } else {
      let desc = new WidgetViewDesc(this.top, widget, view, pos)
      this.top.children.splice(this.index++, 0, desc)
      this.changed = true
    }
  }

  // Make sure a textblock looks and behaves correctly in
  // contentEditable.
  addTextblockHacks() {
    let lastChild = this.top.children[this.index - 1], parent = this.top
    while (lastChild instanceof MarkViewDesc) {
      parent = lastChild
      lastChild = parent.children[parent.children.length - 1]
    }

    if (!lastChild || // Empty textblock
        !(lastChild instanceof TextViewDesc) ||
        /\n$/.test(lastChild.node.text!) ||
        (this.view.requiresGeckoHackNode && /\s$/.test(lastChild.node.text!))) {
      // Avoid bugs in Safari's cursor drawing (#1165) and Chrome's mouse selection (#1152)
      if ((browser.safari || browser.chrome) && lastChild && (lastChild.dom as HTMLElement).contentEditable == "false")
        this.addHackNode("IMG", parent)
      this.addHackNode("BR", this.top)
    }
  }

  addHackNode(nodeName: string, parent: ViewDesc) {
    if (parent == this.top && this.index < parent.children.length && parent.children[this.index].matchesHack(nodeName)) {
      this.index++
    } else {
      let dom = document.createElement(nodeName)
      if (nodeName == "IMG") {
        dom.className = "ProseMirror-separator"
        ;(dom as HTMLImageElement).alt = ""
      }
      if (nodeName == "BR") dom.className = "ProseMirror-trailingBreak"
      let hack = new TrailingHackViewDesc(this.top, [], dom, null)
      if (parent != this.top) parent.children.push(hack)
      else parent.children.splice(this.index++, 0, hack)
      this.changed = true
    }
  }

  isLocked(node: DOMNode) {
    return this.lock && (node == this.lock || node.nodeType == 1 && node.contains(this.lock.parentNode))
  }
}

// Iterate from the end of the fragment and array of descs to find
// directly matching ones, in order to avoid overeagerly reusing those
// for other nodes. Returns the fragment index of the first node that
// is part of the sequence of matched nodes at the end of the
// fragment.
function preMatch(
  frag: Fragment, parentDesc: ViewDesc
): {index: number, matched: Map<ViewDesc, number>, matches: readonly ViewDesc[]} {
  let curDesc = parentDesc, descI = curDesc.children.length
  let fI = frag.childCount, matched = new Map, matches = []
  outer: while (fI > 0) {
    let desc
    for (;;) {
      if (descI) {
        let next = curDesc.children[descI - 1]
        if (next instanceof MarkViewDesc) {
          curDesc = next
          descI = next.children.length
        } else {
          desc = next
          descI--
          break
        }
      } else if (curDesc == parentDesc) {
        break outer
      } else {
        // FIXME
        descI = curDesc.parent!.children.indexOf(curDesc)
        curDesc = curDesc.parent!
      }
    }
    let node = desc.node
    if (!node) continue
    if (node != frag.child(fI - 1)) break
    --fI
    matched.set(desc, fI)
    matches.push(desc)
  }
  return {index: fI, matched, matches: matches.reverse()}
}

function compareSide(a: Decoration, b: Decoration) {
  return (a.type as WidgetType).side - (b.type as WidgetType).side
}

// This function abstracts iterating over the nodes and decorations in
// a fragment. Calls `onNode` for each node, with its local and child
// decorations. Splits text nodes when there is a decoration starting
// or ending inside of them. Calls `onWidget` for each widget.
function iterDeco(
  parent: Node,
  deco: DecorationSource,
  onWidget: (widget: Decoration, index: number, insideNode: boolean) => void,
  onNode: (node: Node, outerDeco: readonly Decoration[], innerDeco: DecorationSource, index: number) => void
) {
  let locals = deco.locals(parent), offset = 0
  // Simple, cheap variant for when there are no local decorations
  if (locals.length == 0) {
    for (let i = 0; i < parent.childCount; i++) {
      let child = parent.child(i)
      onNode(child, locals, deco.forChild(offset, child), i)
      offset += child.nodeSize
    }
    return
  }

  let decoIndex = 0, active = [], restNode = null
  for (let parentIndex = 0;;) {
    if (decoIndex < locals.length && locals[decoIndex].to == offset) {
      let widget = locals[decoIndex++], widgets
      while (decoIndex < locals.length && locals[decoIndex].to == offset)
        (widgets || (widgets = [widget])).push(locals[decoIndex++])
      if (widgets) {
        widgets.sort(compareSide)
        for (let i = 0; i < widgets.length; i++) onWidget(widgets[i], parentIndex, !!restNode)
      } else {
        onWidget(widget, parentIndex, !!restNode)
      }
    }

    let child, index
    if (restNode) {
      index = -1
      child = restNode
      restNode = null
    } else if (parentIndex < parent.childCount) {
      index = parentIndex
      child = parent.child(parentIndex++)
    } else {
      break
    }

    for (let i = 0; i < active.length; i++) if (active[i].to <= offset) active.splice(i--, 1)
    while (decoIndex < locals.length && locals[decoIndex].from <= offset && locals[decoIndex].to > offset)
      active.push(locals[decoIndex++])

    let end = offset + child.nodeSize
    if (child.isText) {
      let cutAt = end
      if (decoIndex < locals.length && locals[decoIndex].from < cutAt) cutAt = locals[decoIndex].from
      for (let i = 0; i < active.length; i++) if (active[i].to < cutAt) cutAt = active[i].to
      if (cutAt < end) {
        restNode = child.cut(cutAt - offset)
        child = child.cut(0, cutAt - offset)
        end = cutAt
        index = -1
      }
    }

    let outerDeco = child.isInline && !child.isLeaf ? active.filter(d => !d.inline) : active.slice()
    onNode(child, outerDeco, deco.forChild(offset, child), index)
    offset = end
  }
}

// List markers in Mobile Safari will mysteriously disappear
// sometimes. This works around that.
function iosHacks(dom: HTMLElement) {
  if (dom.nodeName == "UL" || dom.nodeName == "OL") {
    let oldCSS = dom.style.cssText
    dom.style.cssText = oldCSS + "; list-style: square !important"
    window.getComputedStyle(dom).listStyle
    dom.style.cssText = oldCSS
  }
}

function nearbyTextNode(node: DOMNode, offset: number): Text | null {
  for (;;) {
    if (node.nodeType == 3) return node as Text
    if (node.nodeType == 1 && offset > 0) {
      if (node.childNodes.length > offset && node.childNodes[offset].nodeType == 3)
        return node.childNodes[offset] as Text
      node = node.childNodes[offset - 1]
      offset = nodeSize(node)
    } else if (node.nodeType == 1 && offset < node.childNodes.length) {
      node = node.childNodes[offset]
      offset = 0
    } else {
      return null
    }
  }
}

// Find a piece of text in an inline fragment, overlapping from-to
function findTextInFragment(frag: Fragment, text: string, from: number, to: number) {
  for (let i = 0, pos = 0; i < frag.childCount && pos <= to;) {
    let child = frag.child(i++), childStart = pos
    pos += child.nodeSize
    if (!child.isText) continue
    let str = child.text!
    while (i < frag.childCount) {
      let next = frag.child(i++)
      pos += next.nodeSize
      if (!next.isText) break
      str += next.text
    }
    if (pos >= from) {
      let found = childStart < to ? str.lastIndexOf(text, to - childStart - 1) : -1
      if (found >= 0 && found + text.length + childStart >= from)
        return childStart + found
      if (from == to && str.length >= (to + text.length) - childStart &&
          str.slice(to - childStart, to - childStart + text.length) == text)
        return to
    }
  }
  return -1
}

// Replace range from-to in an array of view descs with replacement
// (may be null to just delete). This goes very much against the grain
// of the rest of this code, which tends to create nodes with the
// right shape in one go, rather than messing with them after
// creation, but is necessary in the composition hack.
function replaceNodes(nodes: readonly ViewDesc[], from: number, to: number, view: EditorView, replacement?: ViewDesc) {
  let result = []
  for (let i = 0, off = 0; i < nodes.length; i++) {
    let child = nodes[i], start = off, end = off += child.size
    if (start >= to || end <= from) {
      result.push(child)
    } else {
      if (start < from) result.push((child as MarkViewDesc | TextViewDesc).slice(0, from - start, view))
      if (replacement) {
        result.push(replacement)
        replacement = undefined
      }
      if (end > to) result.push((child as MarkViewDesc | TextViewDesc).slice(to - start, child.size, view))
    }
  }
  return result
}

function overlapHeight(viewport: { top: number, bottom: number }, node: { top: number, bottom: number }) {
  if (viewport.bottom < node.top || node.bottom < viewport.top) return 0;
  const overlapTop = Math.max(viewport.top, node.top);
  const overlapBottom = Math.min(viewport.bottom, node.bottom);

  return overlapBottom - overlapTop;
}

function getParentNodeViewDesc(node?: ViewDesc) {
  let parent = node;
  while (parent instanceof MarkViewDesc) parent = parent.parent;
  return parent;
}
