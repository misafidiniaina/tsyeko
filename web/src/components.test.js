import test from "node:test";
import assert from "node:assert/strict";

import {
  COMPONENT_ROLES,
  createEmptyDocument,
  createNode,
  createPage,
  duplicateNodes,
  getFirstPage,
  getNode,
  NODE_TYPES,
  normalizeDocument,
} from "./model.js";
import {
  createComponent,
  createComponentInstance,
  detachComponentInstance,
  getComponentInstanceCount,
  getComponentInstanceRoot,
  recordComponentOverride,
  resetComponentOverrides,
  syncDocumentComponents,
} from "./components.js";

function makeButtonDocument() {
  const document = createEmptyDocument("Components");
  const page = getFirstPage(document);
  page.name = "Library";
  const button = createNode(NODE_TYPES.FRAME, 40, 60, {
    name: "Button / Primary",
    width: 180,
    height: 56,
    fill: "#7c3aed",
  });
  const label = createNode(NODE_TYPES.TEXT, 66, 76, {
    name: "Label",
    parentId: button.id,
    width: 128,
    height: 28,
    text: "Continue",
    fill: "#ffffff",
    fontSize: 18,
  });
  page.nodes.push(button, label);
  return { document, page, button, label };
}

function makeComponentFixture() {
  const fixture = makeButtonDocument();
  const created = createComponent(fixture.document, fixture.page.id, [fixture.button.id]);
  assert.ok(created.component);
  assert.ok(created.source);
  return { ...fixture, component: created.component };
}

test("migrates v8 documents to v9 with safe component metadata", () => {
  const document = normalizeDocument({
    version: 8,
    name: "Imported components",
    pages: [
      {
        id: "library",
        name: "Library",
        nodes: [
          { id: "main", type: "frame", name: "Tag" },
          { id: "label", type: "text", parentId: "main", text: "Source" },
        ],
      },
      {
        id: "screen",
        name: "Screen",
        nodes: [
          {
            id: "instance",
            type: "frame",
            componentId: "tag",
            componentRole: "instance",
            componentSourceId: "main",
            componentOverrides: { main: { x: 900, fill: "#10b981" } },
          },
          {
            id: "instance-label",
            type: "text",
            parentId: "instance",
            componentId: "tag",
            componentRole: "instance-child",
            componentSourceId: "label",
            componentOverrides: { label: { text: "unsafe location" } },
          },
        ],
      },
    ],
    components: [{
      id: "tag",
      name: "Tag",
      sourcePageId: "library",
      sourceNodeId: "main",
    }],
  });

  const library = document.pages[0];
  const screen = document.pages[1];
  assert.equal(document.version, 9);
  assert.equal(document.components.length, 1);
  assert.equal(getNode(library, "main").componentRole, COMPONENT_ROLES.MAIN);
  assert.equal(getNode(library, "label").componentRole, COMPONENT_ROLES.SOURCE);
  assert.equal(getNode(screen, "instance").componentOverrides.main.x, undefined);
  assert.equal(getNode(screen, "instance").componentOverrides.main.fill, "#10b981");
  assert.deepEqual(getNode(screen, "instance-label").componentOverrides, { label: { text: "unsafe location" } });
});

test("creates a main component and preserves its source tree", () => {
  const { document, page, button, label, component } = makeComponentFixture();

  assert.equal(document.components.length, 1);
  assert.equal(component.sourcePageId, page.id);
  assert.equal(component.sourceNodeId, button.id);
  assert.equal(button.componentRole, COMPONENT_ROLES.MAIN);
  assert.equal(button.componentSourceId, button.id);
  assert.equal(label.componentRole, COMPONENT_ROLES.SOURCE);
  assert.equal(label.componentSourceId, label.id);
});

test("propagates source visual and structural changes to linked instances without moving them", () => {
  const { document, page, button, label, component } = makeComponentFixture();
  const screen = createPage("Screen");
  document.pages.push(screen);
  const first = createComponentInstance(document, component.id, page.id, { x: 340, y: 180 });
  const second = createComponentInstance(document, component.id, screen.id, { x: 520, y: 260 });
  assert.ok(first);
  assert.ok(second);

  button.fill = "#0f766e";
  label.text = "Save changes";
  const badge = createNode(NODE_TYPES.ELLIPSE, 184, 72, {
    name: "Badge",
    parentId: button.id,
    width: 20,
    height: 20,
    fill: "#fbbf24",
  });
  page.nodes.push(badge);
  syncDocumentComponents(document);

  const firstRoot = getNode(page, first.id);
  const secondRoot = getNode(screen, second.id);
  const firstLabel = page.nodes.find((node) => node.componentSourceId === label.id && node.componentRole === COMPONENT_ROLES.INSTANCE_CHILD);
  const secondLabel = screen.nodes.find((node) => node.componentSourceId === label.id && node.componentRole === COMPONENT_ROLES.INSTANCE_CHILD);
  const firstBadge = page.nodes.find((node) => node.componentSourceId === badge.id && node.componentRole === COMPONENT_ROLES.INSTANCE_CHILD);
  const secondBadge = screen.nodes.find((node) => node.componentSourceId === badge.id && node.componentRole === COMPONENT_ROLES.INSTANCE_CHILD);

  assert.equal(firstRoot.x, 340);
  assert.equal(firstRoot.y, 180);
  assert.equal(secondRoot.x, 520);
  assert.equal(secondRoot.y, 260);
  assert.equal(firstRoot.fill, "#0f766e");
  assert.equal(secondRoot.fill, "#0f766e");
  assert.equal(firstLabel.text, "Save changes");
  assert.equal(secondLabel.text, "Save changes");
  assert.ok(firstBadge);
  assert.ok(secondBadge);
  assert.equal(firstBadge.parentId, firstRoot.id);
  assert.equal(secondBadge.parentId, secondRoot.id);
});

test("keeps instance overrides local, supports reset, and keeps stable instance ids", () => {
  const { document, page, button, label, component } = makeComponentFixture();
  const instance = createComponentInstance(document, component.id, page.id, { x: 360, y: 160 });
  const instanceLabel = page.nodes.find((node) => node.componentSourceId === label.id && node.componentRole === COMPONENT_ROLES.INSTANCE_CHILD);
  assert.ok(instanceLabel);

  instanceLabel.text = "Only here";
  instanceLabel.fill = "#fef3c7";
  recordComponentOverride(document, page, instanceLabel, "text");
  recordComponentOverride(document, page, instanceLabel, "fill");
  label.text = "Source update";
  label.fill = "#ffffff";
  syncDocumentComponents(document);

  const syncedLabel = getNode(page, instanceLabel.id);
  assert.equal(syncedLabel.text, "Only here");
  assert.equal(syncedLabel.fill, "#fef3c7");
  assert.equal(getNode(page, instance.id).id, instance.id);

  resetComponentOverrides(document, page, syncedLabel);
  assert.equal(getNode(page, syncedLabel.id).text, "Source update");
  assert.equal(getNode(page, syncedLabel.id).fill, "#ffffff");
  assert.deepEqual(getNode(page, instance.id).componentOverrides, {});
  assert.equal(button.componentRole, COMPONENT_ROLES.MAIN);
});

test("detaching an instance preserves its rendered subtree and stops future synchronization", () => {
  const { document, page, button, label, component } = makeComponentFixture();
  const instance = createComponentInstance(document, component.id, page.id, { x: 320, y: 140 });
  const instanceLabel = page.nodes.find((node) => node.componentSourceId === label.id && node.componentRole === COMPONENT_ROLES.INSTANCE_CHILD);
  const detached = detachComponentInstance(page, instanceLabel);
  assert.equal(detached.id, instance.id);
  assert.equal(detached.componentRole, null);
  assert.equal(getNode(page, instanceLabel.id).componentRole, null);

  label.text = "Changed after detach";
  button.fill = "#ef4444";
  syncDocumentComponents(document);

  assert.equal(getNode(page, instanceLabel.id).text, "Continue");
  assert.notEqual(getNode(page, instance.id).fill, "#ef4444");
  assert.equal(getComponentInstanceCount(document, component.id), 0);
});

test("copies main sources as independent layers and copies an instance as another linked instance", () => {
  const { document, page, button, component } = makeComponentFixture();
  const sourceCopies = duplicateNodes(page, [button.id], 24);
  const copiedSource = sourceCopies.find((node) => node.componentRole === null && node.name.endsWith("copy"));
  assert.ok(copiedSource);
  assert.equal(document.components.length, 1);

  const instance = createComponentInstance(document, component.id, page.id, { x: 360, y: 180 });
  const copies = duplicateNodes(page, [instance.id], 24);
  const copiedInstance = copies.find((node) => node.componentRole === COMPONENT_ROLES.INSTANCE);
  assert.ok(copiedInstance);
  syncDocumentComponents(document);

  assert.equal(getComponentInstanceCount(document, component.id), 2);
  assert.ok(getComponentInstanceRoot(page, copiedInstance.id));
});

