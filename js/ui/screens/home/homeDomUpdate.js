import { getHomeFocusIdentity } from "./homeFocusPolicy.js";

// Compare generated markup, rather than the live DOM: focus, image hydration,
// expansion and trailer playback all add state that a data refresh must retain.
const sourceByNode = new WeakMap();
const mountedShells = new WeakMap();

// Row positions change for every row below one that just arrived. They are left out of the
// comparison and patched on their own, so a row that only moved is not re-diffed card by card.
const POSITION_ATTRIBUTES = ["data-row-index", "data-nav-row"];
const POSITION_ATTRIBUTE_PATTERN = / data-(?:row-index|nav-row)="[^"]*"/g;
const POSITION_SELECTOR = "[data-row-index], [data-nav-row]";

export function hasMountedHomeDom(container) {
  const shell = mountedShells.get(container);
  return Boolean(shell && shell === container.querySelector(".home-shell"));
}

function children(node) {
  return Array.from(node.childNodes).filter(
    (child) => child.nodeType !== 3 || child.textContent.trim()
  );
}

function key(node) {
  if (node.nodeType !== 1) return `node:${node.nodeType}`;
  const identity = getHomeFocusIdentity(node);
  if (identity && node.classList.contains("home-content-card")) {
    return `card:${JSON.stringify(identity)}`;
  }
  if (node.id) return `id:${node.id}`;
  if (node.dataset.rowKey) return `row:${node.dataset.rowKey}`;
  if (node.dataset.trackRowKey) return `track:${node.dataset.trackRowKey}`;
  if (node.dataset.action && node.classList.contains("focusable"))
    return `action:${node.dataset.action}`;
  return `${node.tagName}:${node.classList.item(0) || ""}`;
}

function signature(node) {
  if (node.nodeType !== 1) return node.textContent;
  // Rows/cards are useful unchanged-subtree boundaries. Serializing every
  // wrapper and descendant repeats the same markup at each ancestor depth.
  // Other elements still reconcile attributes and children from source nodes.
  return node.dataset.rowKey || node.classList.contains("home-content-card")
    ? node.outerHTML.replace(POSITION_ATTRIBUTE_PATTERN, "")
    : undefined;
}

function snapshot(source, markup = signature(source)) {
  // Shallow nodes cannot retain entire detached markup trees through parentNode.
  return { node: source.cloneNode(false), markup };
}

function positionNodes(root) {
  const nodes = Array.from(root.querySelectorAll(POSITION_SELECTOR));
  return root.matches(POSITION_SELECTOR) ? [root, ...nodes] : nodes;
}

// Copies the position attributes of an otherwise identical subtree. Returns false when the
// trees do not line up (e.g. runtime-added nodes), so the caller falls back to a full update.
function patchPositions(node, source) {
  const live = positionNodes(node);
  const next = positionNodes(source);
  if (live.length !== next.length) return false;
  live.forEach((element, index) => {
    POSITION_ATTRIBUTES.forEach((name) => {
      const value = next[index].getAttribute(name);
      if (value !== null && element.getAttribute(name) !== value) element.setAttribute(name, value);
    });
  });
  return true;
}

function remember(node, source) {
  sourceByNode.set(node, snapshot(source));
  const liveChildren = children(node);
  children(source).forEach((child, index) => remember(liveChildren[index], child));
}

export function registerHomeDomNodes(nodes) {
  nodes.forEach((node) => remember(node, node));
}

function updateAttributes(node, previous, next) {
  const names = new Set(
    [...Array.from(previous.attributes), ...Array.from(next.attributes)].map((attr) => attr.name)
  );
  names.forEach((name) => {
    const oldValue = previous.getAttribute(name);
    const newValue = next.getAttribute(name);
    if (oldValue === newValue) return;
    if (name === "class") {
      Array.from(previous.classList).forEach((token) => {
        if (
          node.classList.contains("home-content-card") &&
          ["focused", "is-expanded", "is-trailer-active", "is-expanded-backdrop-ready"].includes(
            token
          )
        )
          return;
        if (!next.classList.contains(token)) node.classList.remove(token);
      });
      Array.from(next.classList).forEach((token) => {
        if (
          node.classList.contains("home-content-card") &&
          ["focused", "is-expanded", "is-trailer-active", "is-expanded-backdrop-ready"].includes(
            token
          )
        )
          return;
        if (!previous.classList.contains(token)) node.classList.add(token);
      });
    } else if (name === "style") {
      const properties = new Set([...Array.from(previous.style), ...Array.from(next.style)]);
      properties.forEach((property) => {
        if (previous.style.getPropertyValue(property) === next.style.getPropertyValue(property))
          return;
        const value = next.style.getPropertyValue(property);
        if (value)
          node.style.setProperty(property, value, next.style.getPropertyPriority(property));
        else node.style.removeProperty(property);
      });
    } else if (newValue === null) {
      node.removeAttribute(name);
    } else {
      node.setAttribute(name, newValue);
    }
  });
  // A hydrated deferred image must not keep showing its old URL after its
  // source changes. The existing Home hydration pass loads the new data-src.
  if (
    node.tagName === "IMG" &&
    previous.getAttribute("data-src") !== next.getAttribute("data-src") &&
    !next.hasAttribute("src")
  ) {
    node.removeAttribute("src");
  }
}

function updateNode(node, source, protectedNode) {
  const previous = sourceByNode.get(node);
  const markup = signature(source);
  if (markup !== undefined && previous.markup === markup) {
    if (node.nodeType !== 1) return;
    if (patchPositions(node, source)) {
      sourceByNode.set(node, snapshot(source, markup));
      return;
    }
  }
  if (node.nodeType === 1) {
    updateAttributes(node, previous.node, source);
    updateChildren(node, source, protectedNode);
  } else {
    node.textContent = source.textContent;
  }
  sourceByNode.set(node, snapshot(source, markup));
}

function updateChildren(parent, source, protectedNode) {
  const available = new Map();
  children(parent).forEach((node) => {
    const previous = sourceByNode.get(node);
    if (!previous) return; // Runtime-owned trailer/GIF/transition nodes.
    const nodeKey = key(previous.node);
    if (!available.has(nodeKey)) available.set(nodeKey, []);
    available.get(nodeKey).push(node);
  });
  const desired = children(source).map((child) => {
    const candidates = available.get(key(child));
    const existing = candidates?.find(
      (node) => node.nodeType === child.nodeType && node.nodeName === child.nodeName
    );
    if (existing) {
      candidates.splice(candidates.indexOf(existing), 1);
      updateNode(existing, child, protectedNode);
      return existing;
    }
    const inserted = child.cloneNode(true);
    remember(inserted, child);
    return inserted;
  });
  available.forEach((nodes) => nodes.forEach((node) => node.remove()));

  const desiredSet = new Set(desired);
  const nextManagedSibling = (node) => {
    let sibling = node.nextSibling;
    while (sibling && !desiredSet.has(sibling)) sibling = sibling.nextSibling;
    return sibling;
  };

  // insertBefore() detaches an existing node and can blur its descendants.
  // Keep the branch containing focus anchored and reorder its siblings around it.
  const anchorIndex = desired.findIndex(
    (node) => node === protectedNode || node.contains(protectedNode)
  );
  let before = anchorIndex >= 0 ? desired[anchorIndex] : null;
  for (let index = (anchorIndex >= 0 ? anchorIndex : desired.length) - 1; index >= 0; index -= 1) {
    const node = desired[index];
    if (node.parentNode !== parent || nextManagedSibling(node) !== before)
      parent.insertBefore(node, before);
    before = node;
  }
  if (anchorIndex >= 0) {
    let after = desired[anchorIndex];
    for (let index = anchorIndex + 1; index < desired.length; index += 1) {
      const node = desired[index];
      if (node.parentNode !== parent || nextManagedSibling(after) !== node)
        parent.insertBefore(node, after.nextSibling);
      after = node;
    }
  }
}

let inertDocument = null;

// The comparison tree is parsed in a document without a browsing context, so its
// <img> nodes never start fetching or decoding; inserted clones load once adopted.
function createSourceRoot(ownerDocument) {
  if (!inertDocument) {
    inertDocument = ownerDocument.implementation?.createHTMLDocument?.("") || ownerDocument;
  }
  return inertDocument.createElement("div");
}

export function updateHomeDom(container, markup, { incremental = false, focusedNode = null } = {}) {
  const source = createSourceRoot(container.ownerDocument);
  source.innerHTML = markup;
  const canUpdate = incremental && hasMountedHomeDom(container);
  if (canUpdate) {
    updateChildren(container, source, focusedNode);
  } else {
    container.innerHTML = markup;
    remember(container, source);
  }
  mountedShells.set(container, container.querySelector(".home-shell"));
  return Boolean(canUpdate);
}
