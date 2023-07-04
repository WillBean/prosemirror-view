import {NodeSelection, EditorState, Plugin, PluginView, Transaction, Selection} from "prosemirror-state"
import {Slice, ResolvedPos, DOMParser, DOMSerializer, Node, Mark} from "prosemirror-model"

import {scrollRectIntoView, posAtCoords, coordsAtPos, endOfTextblock, storeScrollPos,
        resetScrollPos, focusPreventScroll} from "./domcoords"
import {docViewDesc, ViewDesc, NodeView, NodeViewDesc, WalkDirection, WalkStrategy, ViewDescRenderer} from "./viewdesc"
import {initInput, destroyInput, dispatchEvent, ensureListeners, clearComposition, InputState, doPaste} from "./input"
import {selectionToDOM, anchorInRightPlace, syncNodeSelection} from "./selection"
import {Decoration, viewDecorations, DecorationSource} from "./decoration"
import {DOMObserver, safariShadowSelectionRange} from "./domobserver"
import {readDOMChange} from "./domchange"
import {DOMSelection, DOMNode, DOMSelectionRange, deepActiveElement} from "./dom"
import * as browser from "./browser"

export {Decoration, DecorationSet, DecorationAttrs, DecorationSource} from "./decoration"
export {NodeView} from "./viewdesc"

// Exported for testing
import {serializeForClipboard, parseFromClipboard} from "./clipboard"
import {endComposition} from "./input"
import schedule, { SchedulePriority } from "./schedule"
/// @internal
export const __serializeForClipboard = serializeForClipboard
/// @internal
export const __parseFromClipboard = parseFromClipboard
/// @internal
export const __endComposition = endComposition

/// An editor view manages the DOM structure that represents an
/// editable document. Its state and behavior are determined by its
/// [props](#view.DirectEditorProps).
export class EditorView {
  private _props: DirectEditorProps
  private directPlugins: readonly Plugin[]
  private _root: Document | ShadowRoot | null = null
  /// @internal
  focused = false
  /// Kludge used to work around a Chrome bug @internal
  trackWrites: DOMNode | null = null
  /// @internal
  trackSkipUpdate = false
  private mounted = false
  /// @internal
  markCursor: readonly Mark[] | null = null
  /// @internal
  cursorWrapper: {dom: DOMNode, deco: Decoration} | null = null
  /// @internal
  nodeViews: NodeViewSet
  /// @internal
  lastSelectedViewDesc: ViewDesc | undefined = undefined
  /// @internal
  docView: NodeViewDesc
  /// @internal
  input = new InputState
  private prevDirectPlugins: readonly Plugin[] = []
  private pluginViews: PluginView[] = []
  /// @internal
  domObserver!: DOMObserver
  /// Holds `true` when a hack node is needed in Firefox to prevent the
  /// [space is eaten issue](https://github.com/ProseMirror/prosemirror/issues/651)
  /// @internal
  requiresGeckoHackNode: boolean = false

  /// The view's current [state](#state.EditorState).
  public state: EditorState

  private renderTaskId: number | null = null;

  private lastScrollTop = 0;

  private upwardClean = true;

  /// Create a view. `place` may be a DOM node that the editor should
  /// be appended to, a function that will place it into the document,
  /// or an object whose `mount` property holds the node to use as the
  /// document container. If it is `null`, the editor will not be
  /// added to the document.
  constructor(place: null | DOMNode | ((editor: HTMLElement) => void) | {mount: HTMLElement}, props: DirectEditorProps) {
    this._props = props
    this.state = props.state
    this.directPlugins = props.plugins || []
    this.directPlugins.forEach(checkStateComponent)

    this.dispatch = this.dispatch.bind(this)

    this.dom = (place && (place as {mount: HTMLElement}).mount) || document.createElement("div")
    if (place) {
      if ((place as DOMNode).appendChild) (place as DOMNode).appendChild(this.dom)
      else if (typeof place == "function") place(this.dom)
      else if ((place as {mount: HTMLElement}).mount) this.mounted = true
    }

    this.editable = getEditable(this)
    updateCursorWrapper(this)
    this.nodeViews = buildNodeViews(this)
    this.docView = docViewDesc(this.state.doc, computeDocDeco(this), viewDecorations(this), this.dom, this)

    this.domObserver = new DOMObserver(this, (from, to, typeOver, added) => readDOMChange(this, from, to, typeOver, added))
    this.domObserver.start()
    initInput(this)
    this.updatePluginViews()
  }

  /// An editable DOM node containing the document. (You probably
  /// should not directly interfere with its content.)
  readonly dom: HTMLElement

  /// Indicates whether the editor is currently [editable](#view.EditorProps.editable).
  editable: boolean

  /// When editor content is being dragged, this object contains
  /// information about the dragged slice and whether it is being
  /// copied or moved. At any other time, it is null.
  dragging: null | {slice: Slice, move: boolean} = null

  /// Holds `true` when a
  /// [composition](https://w3c.github.io/uievents/#events-compositionevents)
  /// is active.
  get composing() { return this.input.composing }

  /// The view's current [props](#view.EditorProps).
  get props() {
    if (this._props.state != this.state) {
      let prev = this._props
      this._props = {} as any
      for (let name in prev) (this._props as any)[name] = (prev as any)[name]
      this._props.state = this.state
    }
    return this._props
  }

  /**
   *
   */
  getLayoutInfo(pos: number) {}

  /// Update the view's props. Will immediately cause an update to
  /// the DOM.
  update(props: DirectEditorProps) {
    if (props.handleDOMEvents != this._props.handleDOMEvents) ensureListeners(this)
    let prevProps = this._props
    this._props = props
    if (props.plugins) {
      props.plugins.forEach(checkStateComponent)
      this.directPlugins = props.plugins
    }
    this.updateStateInner(props.state, prevProps)
  }

  /// Update the view by updating existing props object with the object
  /// given as argument. Equivalent to `view.update(Object.assign({},
  /// view.props, props))`.
  setProps(props: Partial<DirectEditorProps>) {
    let updated = {} as DirectEditorProps
    for (let name in this._props) (updated as any)[name] = (this._props as any)[name]
    updated.state = this.state
    for (let name in props) (updated as any)[name] = (props as any)[name]
    this.update(updated)
  }

  onScroll() {
    const viewport = this.getViewport();

    if (!viewport) return;

    this.domObserver.stop()

    const shouldLock = this.forceLayoutUpwardNodes();

    if (shouldLock) {
      this.lockViewport(() => this.docView.updateViewport(this, viewport));
    } else {
      this.docView.updateViewport(this, viewport);
    }

    this.lastScrollTop = viewport.scrollTop;
    this.domObserver.start()
  }

  // 判断视口上方一定范围内是否存在 layout dirty 的节点，是则强制 layout 一次，避免向上滚动时视口跳动
  private forceLayoutUpwardNodes() {
    const viewport = this.getViewport();

    if (!this._props.viewport?.getForceLayoutDistance || !viewport || this.upwardClean || viewport.scrollTop >= this.lastScrollTop) return false;

    const rects = this.docView.getRects();
    const [first] = this.docView.bufferNodes.size ? this.docView.bufferNodes : this.docView.viewportNodes;
    const forceLayoutDistance = this._props.viewport.getForceLayoutDistance();

    let index = this.docView.children.indexOf(first) - 1;
    let rect = rects[index];

    const dirtyNodes = new Set<ViewDescRenderer>();
    while (index > 0 && rect?.top > viewport.scrollTop - forceLayoutDistance) {
      rect.node.walk(WalkDirection.Down, WalkStrategy.Post, (node) => {
        if (node.layoutInfo.isDirty) dirtyNodes.add(node);
        return false;
      });
      rect = rects[--index];
    }
    const renderMap = Array.from(dirtyNodes).reverse()
      .reduce<Map<ViewDescRenderer, Set<ViewDescRenderer>>>((map, node) => {
        if (!node.parent) return map;
        if (!map.has(node.parent)) map.set(node.parent, new Set());
        map.get(node.parent)?.add(node);
        return map;
      }, new Map());

    renderMap.forEach((children, parent) => {
      parent.ensureChildrenRendered(this, children);
      parent.mountChildren(this, children);
    });
    dirtyNodes.forEach(node => node.layout());

    return !!dirtyNodes.size;
  }

  /// Update the editor's `state` prop, without touching any of the
  /// other props.
  updateState(state: EditorState) {
    this.updateStateInner(state, this._props)
  }

  private updateStateInner(state: EditorState, prevProps: DirectEditorProps) {
    let prev = this.state, redraw = false, updateSel = false
    // When stored marks are added, stop composition, so that they can
    // be displayed.
    if (state.storedMarks && this.composing) {
      clearComposition(this)
      updateSel = true
    }
    this.state = state
    let pluginsChanged = prev.plugins != state.plugins || this._props.plugins != prevProps.plugins
    if (pluginsChanged || this._props.plugins != prevProps.plugins || this._props.nodeViews != prevProps.nodeViews) {
      let nodeViews = buildNodeViews(this)
      if (changedNodeViews(nodeViews, this.nodeViews)) {
        this.nodeViews = nodeViews
        redraw = true
      }
    }
    if (pluginsChanged || prevProps.handleDOMEvents != this._props.handleDOMEvents) {
      ensureListeners(this)
    }

    this.editable = getEditable(this)
    updateCursorWrapper(this)
    let innerDeco = viewDecorations(this), outerDeco = computeDocDeco(this)

    let scroll = prev.plugins != state.plugins && !prev.doc.eq(state.doc) ? "reset"
        : (state as any).scrollToSelection > (prev as any).scrollToSelection ? "to selection" : "preserve"
    let updateDoc = redraw || !this.docView.matchesNode(state.doc, outerDeco, innerDeco)
    if (updateDoc || !state.selection.eq(prev.selection)) updateSel = true
    let oldScrollPos = scroll == "preserve" && updateSel && this.dom.style.overflowAnchor == null && storeScrollPos(this)

    if (updateSel) {
      this.domObserver.stop()
      // Work around an issue in Chrome, IE, and Edge where changing
      // the DOM around an active selection puts it into a broken
      // state where the thing the user sees differs from the
      // selection reported by the Selection object (#710, #973,
      // #1011, #1013, #1035).
      let forceSelUpdate = updateDoc && (browser.ie || browser.chrome) && !this.composing &&
          !prev.selection.empty && !state.selection.empty && selectionContextChanged(prev.selection, state.selection)
      if (updateDoc) {
        let chromeKludge = browser.chrome ? (this.trackWrites = this.domSelectionRange().focusNode) : null
        this.lockViewport(() => {
          // If the node that the selection points into is written to,
          // Chrome sometimes starts misreporting the selection, so this
          // tracks that and forces a selection reset when our update
          // did write to the node.
          if (redraw || !this.docView.update(state.doc, outerDeco, innerDeco, this)) {
            this.docView.updateOuterDeco([])
            this.docView.destroy()
            this.docView = docViewDesc(state.doc, outerDeco, innerDeco, this.dom, this)
          }
          const { viewport } = this._props;
        // TODO: 只有变更才调用
          viewport && !this.trackSkipUpdate && this.docView.updateViewport(this, this.getViewport()!);
        });
        this.startIdleRenderTask();
        this.trackSkipUpdate = false;
        if (chromeKludge && !this.trackWrites) forceSelUpdate = true
      }
      // Work around for an issue where an update arriving right between
      // a DOM selection change and the "selectionchange" event for it
      // can cause a spurious DOM selection update, disrupting mouse
      // drag selection.
      if (forceSelUpdate ||
          !(this.input.mouseDown && this.domObserver.currentSelection.eq(this.domSelectionRange()) &&
            anchorInRightPlace(this))) {
        selectionToDOM(this, forceSelUpdate)
      } else {
        syncNodeSelection(this, state.selection)
        this.domObserver.setCurSelection()
      }
      this.domObserver.start()
    }

    this.updatePluginViews(prev)

    if (scroll == "reset") {
      this.dom.scrollTop = 0
    } else if (scroll == "to selection") {
      this.scrollToSelection()
    } else if (oldScrollPos) {
      resetScrollPos(oldScrollPos)
    }
  }

  /// @internal
  scrollToSelection() {
    let startDOM = this.domSelectionRange().focusNode!
    if (this.someProp("handleScrollToSelection", f => f(this))) {
      // Handled
    } else if (this.state.selection instanceof NodeSelection) {
      let target = this.docView.domAfterPos(this.state.selection.from)
      if (target.nodeType == 1) scrollRectIntoView(this, (target as HTMLElement).getBoundingClientRect(), startDOM)
    } else {
      scrollRectIntoView(this, this.coordsAtPos(this.state.selection.head, 1), startDOM)
    }
  }

  private getViewport() {
    const { viewport } = this._props;

    if (!viewport) return;

    return {
      buffer: viewport.getBuffer?.(),
      scrollTop: viewport.getScrollTop() - viewport.getOffsetToScroller(),
      scrollHeight: viewport.getScrollHeight(),
    };
  }

  private startIdleRenderTask() {
    if (this.renderTaskId !== null) schedule.cancelTask(this.renderTaskId);

    this.renderTaskId = schedule.addTask({
      priority: SchedulePriority.Low,
      callback: () => {
        if (this.isDestroyed) return;

        const [first, ...rest] = this.docView.bufferNodes.size ? this.docView.bufferNodes : this.docView.viewportNodes;
        const last = rest[rest.length - 1];

        const render = (node) => {
          if (node.isRendered) return false;
          node.parent!.ensureChildrenRendered(this, new Set([node]));
          return true;
        };

        const foundUpward = this.docView.walk(WalkDirection.Up, WalkStrategy.Pre, render, this.docView.children.indexOf(first));
        const foundDownward = !foundUpward && this.docView.walk(WalkDirection.Down, WalkStrategy.Pre, render, this.docView.children.indexOf(last));

        this.renderTaskId = null;

        if (foundUpward || foundDownward) {
          this.startIdleRenderTask();
        } else {
          this.startIdleLayoutTask();
        }
      },
    });
  }

  private startIdleLayoutTask() {
    if (this.renderTaskId !== null) schedule.cancelTask(this.renderTaskId);

    this.renderTaskId = schedule.addTask({
      priority: SchedulePriority.Low,
      callback: () => {
        if (this.isDestroyed) return;

        const [first, ...rest] = this.docView.viewportNodes;
        const last = rest[rest.length - 1];

        const render = (node) => {
          if (!node.node || node.node.isInline || !node.layoutInfo.isDirty) return false;

          this.lockViewport(() => {
            node.layout(this, new Set([node]));
            this.docView.updateViewport(this, this.getViewport()!);
          });
          return true;
        };

        const foundDirty = this.docView.walk(WalkDirection.Up, WalkStrategy.Post, render, this.docView.children.indexOf(first));
        // const downwardLayouted = !upwardLayouted && this.docView.walk(WalkDirection.Down, WalkStrategy.Post, render, this.docView.children.indexOf(last));

        this.renderTaskId = null;
        this.upwardClean = !foundDirty;

        if (foundDirty) {
          this.startIdleLayoutTask();
        }
      },
    });
  }

  private lockViewport(fn: () => void) {
    const node = this.docView.getInnerViewportNode();

    if (!this._props.viewport || !node || !(node.dom instanceof HTMLElement)) return fn();

    const top3 = node.dom.offsetTop;
    let top = node.getOffsetTopToRoot();

    // TODO: keep on dom
    node.keep = true;

    fn();

    let afterTop: number;
    // 如果 buffer 内存在变更，只能从 dom 上读取 offsetTop，因为此时还没有对节点重新 layout
    if (Array.from(this.docView.bufferNodes).find(node => node.layoutInfo.isDirty)) {
      top = Math.ceil(top);
      afterTop = node.dom.offsetTop;
    } else {
      afterTop = node.getOffsetTopToRoot();
    }
    const delta3 = node.dom.offsetTop - top3;
    const delta = afterTop - top;

    node.keep = false;

    console.warn(delta, '>>>>>>>>>', delta3)
    const { viewport } = this._props;
    delta && viewport.setScrollTop(viewport.getScrollTop() + delta);
  }

  private destroyPluginViews() {
    let view
    while (view = this.pluginViews.pop()) if (view.destroy) view.destroy()
  }

  private updatePluginViews(prevState?: EditorState) {
    if (!prevState || prevState.plugins != this.state.plugins || this.directPlugins != this.prevDirectPlugins) {
      this.prevDirectPlugins = this.directPlugins
      this.destroyPluginViews()
      for (let i = 0; i < this.directPlugins.length; i++) {
        let plugin = this.directPlugins[i]
        if (plugin.spec.view) this.pluginViews.push(plugin.spec.view(this))
      }
      for (let i = 0; i < this.state.plugins.length; i++) {
        let plugin = this.state.plugins[i]
        if (plugin.spec.view) this.pluginViews.push(plugin.spec.view(this))
      }
    } else {
      for (let i = 0; i < this.pluginViews.length; i++) {
        let pluginView = this.pluginViews[i]
        if (pluginView.update) pluginView.update(this, prevState)
      }
    }
  }

  /// Goes over the values of a prop, first those provided directly,
  /// then those from plugins given to the view, then from plugins in
  /// the state (in order), and calls `f` every time a non-undefined
  /// value is found. When `f` returns a truthy value, that is
  /// immediately returned. When `f` isn't provided, it is treated as
  /// the identity function (the prop value is returned directly).
  someProp<PropName extends keyof EditorProps, Result>(
    propName: PropName,
    f: (value: NonNullable<EditorProps[PropName]>) => Result
  ): Result | undefined
  someProp<PropName extends keyof EditorProps>(propName: PropName): NonNullable<EditorProps[PropName]> | undefined
  someProp<PropName extends keyof EditorProps, Result>(
    propName: PropName,
    f?: (value: NonNullable<EditorProps[PropName]>) => Result
  ): Result | undefined {
    let prop = this._props && this._props[propName], value
    if (prop != null && (value = f ? f(prop as any) : prop)) return value as any
    for (let i = 0; i < this.directPlugins.length; i++) {
      let prop = this.directPlugins[i].props[propName]
      if (prop != null && (value = f ? f(prop as any) : prop)) return value as any
    }
    let plugins = this.state.plugins
    if (plugins) for (let i = 0; i < plugins.length; i++) {
      let prop = plugins[i].props[propName]
      if (prop != null && (value = f ? f(prop as any) : prop)) return value as any
    }
  }

  /// Query whether the view has focus.
  hasFocus() {
    // Work around IE not handling focus correctly if resize handles are shown.
    // If the cursor is inside an element with resize handles, activeElement
    // will be that element instead of this.dom.
    if (browser.ie) {
      // If activeElement is within this.dom, and there are no other elements
      // setting `contenteditable` to false in between, treat it as focused.
      let node = this.root.activeElement
      if (node == this.dom) return true
      if (!node || !this.dom.contains(node)) return false
      while (node && this.dom != node && this.dom.contains(node)) {
        if ((node as HTMLElement).contentEditable == 'false') return false
        node = node.parentElement
      }
      return true
    }
    return this.root.activeElement == this.dom
  }

  /// Focus the editor.
  focus() {
    this.domObserver.stop()
    if (this.editable) focusPreventScroll(this.dom)
    selectionToDOM(this)
    this.domObserver.start()
  }

  /// Get the document root in which the editor exists. This will
  /// usually be the top-level `document`, but might be a [shadow
  /// DOM](https://developer.mozilla.org/en-US/docs/Web/Web_Components/Shadow_DOM)
  /// root if the editor is inside one.
  get root(): Document | ShadowRoot {
    let cached = this._root
    if (cached == null) for (let search = this.dom.parentNode; search; search = search.parentNode) {
      if (search.nodeType == 9 || (search.nodeType == 11 && (search as any).host)) {
        if (!(search as any).getSelection)
          Object.getPrototypeOf(search).getSelection = () => (search as DOMNode).ownerDocument!.getSelection()
        return this._root = search as Document | ShadowRoot
      }
    }
    return cached || document
  }

  /// Given a pair of viewport coordinates, return the document
  /// position that corresponds to them. May return null if the given
  /// coordinates aren't inside of the editor. When an object is
  /// returned, its `pos` property is the position nearest to the
  /// coordinates, and its `inside` property holds the position of the
  /// inner node that the position falls inside of, or -1 if it is at
  /// the top level, not in any node.
  posAtCoords(coords: {left: number, top: number}): {pos: number, inside: number} | null {
    return posAtCoords(this, coords)
  }

  /// Returns the viewport rectangle at a given document position.
  /// `left` and `right` will be the same number, as this returns a
  /// flat cursor-ish rectangle. If the position is between two things
  /// that aren't directly adjacent, `side` determines which element
  /// is used. When < 0, the element before the position is used,
  /// otherwise the element after.
  coordsAtPos(pos: number, side = 1): {left: number, right: number, top: number, bottom: number} {
    return coordsAtPos(this, pos, side)
  }

  /// Find the DOM position that corresponds to the given document
  /// position. When `side` is negative, find the position as close as
  /// possible to the content before the position. When positive,
  /// prefer positions close to the content after the position. When
  /// zero, prefer as shallow a position as possible.
  ///
  /// Note that you should **not** mutate the editor's internal DOM,
  /// only inspect it (and even that is usually not necessary).
  domAtPos(pos: number, side = 0): {node: DOMNode, offset: number} {
    return this.docView.domFromPos(pos, side)
  }

  /// Find the DOM node that represents the document node after the
  /// given position. May return `null` when the position doesn't point
  /// in front of a node or if the node is inside an opaque node view.
  ///
  /// This is intended to be able to call things like
  /// `getBoundingClientRect` on that DOM node. Do **not** mutate the
  /// editor DOM directly, or add styling this way, since that will be
  /// immediately overriden by the editor as it redraws the node.
  nodeDOM(pos: number): DOMNode | null {
    let desc = this.docView.descAt(pos)
    return desc ? (desc as NodeViewDesc).nodeDOM : null
  }

  /// Find the document position that corresponds to a given DOM
  /// position. (Whenever possible, it is preferable to inspect the
  /// document structure directly, rather than poking around in the
  /// DOM, but sometimes—for example when interpreting an event
  /// target—you don't have a choice.)
  ///
  /// The `bias` parameter can be used to influence which side of a DOM
  /// node to use when the position is inside a leaf node.
  posAtDOM(node: DOMNode, offset: number, bias = -1): number {
    let pos = this.docView.posFromDOM(node, offset, bias)
    if (pos == null) throw new RangeError("DOM position not inside the editor")
    return pos
  }

  /// Find out whether the selection is at the end of a textblock when
  /// moving in a given direction. When, for example, given `"left"`,
  /// it will return true if moving left from the current cursor
  /// position would leave that position's parent textblock. Will apply
  /// to the view's current state by default, but it is possible to
  /// pass a different state.
  endOfTextblock(dir: "up" | "down" | "left" | "right" | "forward" | "backward", state?: EditorState): boolean {
    return endOfTextblock(this, state || this.state, dir)
  }

  /// Run the editor's paste logic with the given HTML string. The
  /// `event`, if given, will be passed to the
  /// [`handlePaste`](#view.EditorProps.handlePaste) hook.
  pasteHTML(html: string, event?: ClipboardEvent) {
    return doPaste(this, "", html, false, event || new ClipboardEvent("paste"))
  }

  /// Run the editor's paste logic with the given plain-text input.
  pasteText(text: string, event?: ClipboardEvent) {
    return doPaste(this, text, null, true, event || new ClipboardEvent("paste"))
  }

  /// Removes the editor from the DOM and destroys all [node
  /// views](#view.NodeView).
  destroy() {
    if (!this.docView) return
    destroyInput(this)
    this.destroyPluginViews()
    if (this.mounted) {
      this.docView.update(this.state.doc, [], viewDecorations(this), this)
      this.dom.textContent = ""
    } else if (this.dom.parentNode) {
      this.dom.parentNode.removeChild(this.dom)
    }
    this.docView.destroy()
    ;(this as any).docView = null
  }

  /// This is true when the view has been
  /// [destroyed](#view.EditorView.destroy) (and thus should not be
  /// used anymore).
  get isDestroyed() {
    return this.docView == null
  }

  /// Used for testing.
  dispatchEvent(event: Event) {
    return dispatchEvent(this, event)
  }

  /// Dispatch a transaction. Will call
  /// [`dispatchTransaction`](#view.DirectEditorProps.dispatchTransaction)
  /// when given, and otherwise defaults to applying the transaction to
  /// the current state and calling
  /// [`updateState`](#view.EditorView.updateState) with the result.
  /// This method is bound to the view instance, so that it can be
  /// easily passed around.
  dispatch(tr: Transaction) {
    let dispatchTransaction = this._props.dispatchTransaction
    if (dispatchTransaction) dispatchTransaction.call(this, tr)
    else this.updateState(this.state.apply(tr))
  }

  /// @internal
  domSelectionRange(): DOMSelectionRange {
    return browser.safari && this.root.nodeType === 11 && deepActiveElement(this.dom.ownerDocument) == this.dom
      ? safariShadowSelectionRange(this) : this.domSelection()
  }

  /// @internal
  domSelection(): DOMSelection {
    return (this.root as Document).getSelection()!
  }
}

function computeDocDeco(view: EditorView) {
  let attrs = Object.create(null)
  attrs.class = "ProseMirror"
  attrs.contenteditable = String(view.editable)

  view.someProp("attributes", value => {
    if (typeof value == "function") value = value(view.state)
    if (value) for (let attr in value) {
      if (attr == "class")
        attrs.class += " " + value[attr]
      else if (attr == "style")
        attrs.style = (attrs.style ? attrs.style + ";" : "") + value[attr]
      else if (!attrs[attr] && attr != "contenteditable" && attr != "nodeName")
        attrs[attr] = String(value[attr])
    }
  })
  if (!attrs.translate) attrs.translate = "no"

  return [Decoration.node(0, view.state.doc.content.size, attrs)]
}

function updateCursorWrapper(view: EditorView) {
  if (view.markCursor) {
    let dom = document.createElement("img")
    dom.className = "ProseMirror-separator"
    dom.setAttribute("mark-placeholder", "true")
    dom.setAttribute("alt", "")
    view.cursorWrapper = {dom, deco: Decoration.widget(view.state.selection.head,
                                                       dom, {raw: true, marks: view.markCursor} as any)}
  } else {
    view.cursorWrapper = null
  }
}

function getEditable(view: EditorView) {
  return !view.someProp("editable", value => value(view.state) === false)
}

function selectionContextChanged(sel1: Selection, sel2: Selection) {
  let depth = Math.min(sel1.$anchor.sharedDepth(sel1.head), sel2.$anchor.sharedDepth(sel2.head))
  return sel1.$anchor.start(depth) != sel2.$anchor.start(depth)
}

function buildNodeViews(view: EditorView) {
  let result: NodeViewSet = Object.create(null)
  function add(obj: NodeViewSet) {
    for (let prop in obj) if (!Object.prototype.hasOwnProperty.call(result, prop))
      result[prop] = obj[prop]
  }
  view.someProp("nodeViews", add)
  view.someProp("markViews", add)
  return result
}

function changedNodeViews(a: NodeViewSet, b: NodeViewSet) {
  let nA = 0, nB = 0
  for (let prop in a) {
    if (a[prop] != b[prop]) return true
    nA++
  }
  for (let _ in b) nB++
  return nA != nB
}

function checkStateComponent(plugin: Plugin) {
  if (plugin.spec.state || plugin.spec.filterTransaction || plugin.spec.appendTransaction)
    throw new RangeError("Plugins passed directly to the view must not have a state component")
}

/// The type of function [provided](#view.EditorProps.nodeViews) to
/// create [node views](#view.NodeView).
export type NodeViewConstructor = (node: Node, view: EditorView, getPos: () => number | undefined,
                                   decorations: readonly Decoration[], innerDecorations: DecorationSource) => NodeView

/// The function types [used](#view.EditorProps.markViews) to create
/// mark views.
export type MarkViewConstructor = (mark: Mark, view: EditorView, inline: boolean) => {dom: HTMLElement, contentDOM?: HTMLElement}

type NodeViewSet = {[name: string]: NodeViewConstructor | MarkViewConstructor}

/// Helper type that maps event names to event object types, but
/// includes events that TypeScript's HTMLElementEventMap doesn't know
/// about.
export interface DOMEventMap extends HTMLElementEventMap {
  [event: string]: any
}

/// Props are configuration values that can be passed to an editor view
/// or included in a plugin. This interface lists the supported props.
///
/// The various event-handling functions may all return `true` to
/// indicate that they handled the given event. The view will then take
/// care to call `preventDefault` on the event, except with
/// `handleDOMEvents`, where the handler itself is responsible for that.
///
/// How a prop is resolved depends on the prop. Handler functions are
/// called one at a time, starting with the base props and then
/// searching through the plugins (in order of appearance) until one of
/// them returns true. For some props, the first plugin that yields a
/// value gets precedence.
///
/// The optional type parameter refers to the type of `this` in prop
/// functions, and is used to pass in the plugin type when defining a
/// [plugin](#state.Plugin).
export interface EditorProps<P = any> {
  /// Can be an object mapping DOM event type names to functions that
  /// handle them. Such functions will be called before any handling
  /// ProseMirror does of events fired on the editable DOM element.
  /// Contrary to the other event handling props, when returning true
  /// from such a function, you are responsible for calling
  /// `preventDefault` yourself (or not, if you want to allow the
  /// default behavior).
  handleDOMEvents?: {
    [event in keyof DOMEventMap]?: (this: P, view: EditorView, event: DOMEventMap[event]) => boolean | void
  }

  /// Called when the editor receives a `keydown` event.
  handleKeyDown?: (this: P, view: EditorView, event: KeyboardEvent) => boolean | void

  /// Handler for `keypress` events.
  handleKeyPress?: (this: P, view: EditorView, event: KeyboardEvent) => boolean | void

  /// Whenever the user directly input text, this handler is called
  /// before the input is applied. If it returns `true`, the default
  /// behavior of actually inserting the text is suppressed.
  handleTextInput?: (this: P, view: EditorView, from: number, to: number, text: string) => boolean | void

  /// Called for each node around a click, from the inside out. The
  /// `direct` flag will be true for the inner node.
  handleClickOn?: (this: P, view: EditorView, pos: number, node: Node, nodePos: number, event: MouseEvent, direct: boolean) => boolean | void

  /// Called when the editor is clicked, after `handleClickOn` handlers
  /// have been called.
  handleClick?: (this: P, view: EditorView, pos: number, event: MouseEvent) => boolean | void

  /// Called for each node around a double click.
  handleDoubleClickOn?: (this: P, view: EditorView, pos: number, node: Node, nodePos: number, event: MouseEvent, direct: boolean) => boolean | void

  /// Called when the editor is double-clicked, after `handleDoubleClickOn`.
  handleDoubleClick?: (this: P, view: EditorView, pos: number, event: MouseEvent) => boolean | void

  /// Called for each node around a triple click.
  handleTripleClickOn?: (this: P, view: EditorView, pos: number, node: Node, nodePos: number, event: MouseEvent, direct: boolean) => boolean | void

  /// Called when the editor is triple-clicked, after `handleTripleClickOn`.
  handleTripleClick?: (this: P, view: EditorView, pos: number, event: MouseEvent) => boolean | void

  /// Can be used to override the behavior of pasting. `slice` is the
  /// pasted content parsed by the editor, but you can directly access
  /// the event to get at the raw content.
  handlePaste?: (this: P, view: EditorView, event: ClipboardEvent, slice: Slice) => boolean | void

  /// Called when something is dropped on the editor. `moved` will be
  /// true if this drop moves from the current selection (which should
  /// thus be deleted).
  handleDrop?: (this: P, view: EditorView, event: DragEvent, slice: Slice, moved: boolean) => boolean | void

  /// Called when the view, after updating its state, tries to scroll
  /// the selection into view. A handler function may return false to
  /// indicate that it did not handle the scrolling and further
  /// handlers or the default behavior should be tried.
  handleScrollToSelection?: (this: P, view: EditorView) => boolean

  /// Can be used to override the way a selection is created when
  /// reading a DOM selection between the given anchor and head.
  createSelectionBetween?: (this: P, view: EditorView, anchor: ResolvedPos, head: ResolvedPos) => Selection | null

  /// The [parser](#model.DOMParser) to use when reading editor changes
  /// from the DOM. Defaults to calling
  /// [`DOMParser.fromSchema`](#model.DOMParser^fromSchema) on the
  /// editor's schema.
  domParser?: DOMParser

  /// Can be used to transform pasted HTML text, _before_ it is parsed,
  /// for example to clean it up.
  transformPastedHTML?: (this: P, html: string, view: EditorView) => string

  /// The [parser](#model.DOMParser) to use when reading content from
  /// the clipboard. When not given, the value of the
  /// [`domParser`](#view.EditorProps.domParser) prop is used.
  clipboardParser?: DOMParser

  /// Transform pasted plain text. The `plain` flag will be true when
  /// the text is pasted as plain text.
  transformPastedText?: (this: P, text: string, plain: boolean, view: EditorView) => string

  /// A function to parse text from the clipboard into a document
  /// slice. Called after
  /// [`transformPastedText`](#view.EditorProps.transformPastedText).
  /// The default behavior is to split the text into lines, wrap them
  /// in `<p>` tags, and call
  /// [`clipboardParser`](#view.EditorProps.clipboardParser) on it.
  /// The `plain` flag will be true when the text is pasted as plain text.
  clipboardTextParser?: (this: P, text: string, $context: ResolvedPos, plain: boolean, view: EditorView) => Slice

  /// Can be used to transform pasted or dragged-and-dropped content
  /// before it is applied to the document.
  transformPasted?: (this: P, slice: Slice, view: EditorView) => Slice

  /// Can be used to transform copied or cut content before it is
  /// serialized to the clipboard.
  transformCopied?: (this: P, slice: Slice, view: EditorView) => Slice

  /// Allows you to pass custom rendering and behavior logic for
  /// nodes. Should map node names to constructor functions that
  /// produce a [`NodeView`](#view.NodeView) object implementing the
  /// node's display behavior. The third argument `getPos` is a
  /// function that can be called to get the node's current position,
  /// which can be useful when creating transactions to update it.
  /// Note that if the node is not in the document, the position
  /// returned by this function will be `undefined`.
  ///
  /// `decorations` is an array of node or inline decorations that are
  /// active around the node. They are automatically drawn in the
  /// normal way, and you will usually just want to ignore this, but
  /// they can also be used as a way to provide context information to
  /// the node view without adding it to the document itself.
  ///
  /// `innerDecorations` holds the decorations for the node's content.
  /// You can safely ignore this if your view has no content or a
  /// `contentDOM` property, since the editor will draw the decorations
  /// on the content. But if you, for example, want to create a nested
  /// editor with the content, it may make sense to provide it with the
  /// inner decorations.
  ///
  /// (For backwards compatibility reasons, [mark
  /// views](#view.EditorProps.markViews) can also be included in this
  /// object.)
  nodeViews?: {[node: string]: NodeViewConstructor}

  /// Pass custom mark rendering functions. Note that these cannot
  /// provide the kind of dynamic behavior that [node
  /// views](#view.NodeView) can—they just provide custom rendering
  /// logic. The third argument indicates whether the mark's content
  /// is inline.
  markViews?: {[mark: string]: MarkViewConstructor}

  /// The DOM serializer to use when putting content onto the
  /// clipboard. If not given, the result of
  /// [`DOMSerializer.fromSchema`](#model.DOMSerializer^fromSchema)
  /// will be used. This object will only have its
  /// [`serializeFragment`](#model.DOMSerializer.serializeFragment)
  /// method called, and you may provide an alternative object type
  /// implementing a compatible method.
  clipboardSerializer?: DOMSerializer

  /// A function that will be called to get the text for the current
  /// selection when copying text to the clipboard. By default, the
  /// editor will use [`textBetween`](#model.Node.textBetween) on the
  /// selected range.
  clipboardTextSerializer?: (this: P, content: Slice, view: EditorView) => string

  /// A set of [document decorations](#view.Decoration) to show in the
  /// view.
  decorations?: (this: P, state: EditorState) => DecorationSource | null | undefined

  /// When this returns false, the content of the view is not directly
  /// editable.
  editable?: (this: P, state: EditorState) => boolean

  /// Control the DOM attributes of the editable element. May be either
  /// an object or a function going from an editor state to an object.
  /// By default, the element will get a class `"ProseMirror"`, and
  /// will have its `contentEditable` attribute determined by the
  /// [`editable` prop](#view.EditorProps.editable). Additional classes
  /// provided here will be added to the class. For other attributes,
  /// the value provided first (as in
  /// [`someProp`](#view.EditorView.someProp)) will be used.
  attributes?: {[name: string]: string} | ((state: EditorState) => {[name: string]: string})

  /// Determines the distance (in pixels) between the cursor and the
  /// end of the visible viewport at which point, when scrolling the
  /// cursor into view, scrolling takes place. Defaults to 0.
  scrollThreshold?: number | {top: number, right: number, bottom: number, left: number}

  /// Determines the extra space (in pixels) that is left above or
  /// below the cursor when it is scrolled into view. Defaults to 5.
  scrollMargin?: number | {top: number, right: number, bottom: number, left: number}
}

/// The props object given directly to the editor view supports some
/// fields that can't be used in plugins:
export interface DirectEditorProps extends EditorProps {
  /// The current state of the editor.
  state: EditorState

  /// A set of plugins to use in the view, applying their [plugin
  /// view](#state.PluginSpec.view) and
  /// [props](#state.PluginSpec.props). Passing plugins with a state
  /// component (a [state field](#state.PluginSpec.state) field or a
  /// [transaction](#state.PluginSpec.filterTransaction) filter or
  /// appender) will result in an error, since such plugins must be
  /// present in the state to work.
  plugins?: readonly Plugin[]

  /// The callback over which to send transactions (state updates)
  /// produced by the view. If you specify this, you probably want to
  /// make sure this ends up calling the view's
  /// [`updateState`](#view.EditorView.updateState) method with a new
  /// state that has the transaction
  /// [applied](#state.EditorState.apply). The callback will be bound to have
  /// the view instance as its `this` binding.
  dispatchTransaction?: (tr: Transaction) => void

  viewport?: {
    getBuffer?(): number;
    setScrollTop(top: number): void;
    getScrollTop(): number;
    getScrollHeight(): number;
    getOffsetToScroller(): number;
    getForceLayoutDistance?(): number;
  },
}
