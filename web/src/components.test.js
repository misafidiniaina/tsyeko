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
  createComponentSet,
  detachComponentInstance,
  dissolveComponentSet,
  getComponentOverrideEntries,
  getComponentInstanceCount,
  getComponentInstanceRoot,
  getComponentVariantControls,
  recordComponentOverride,
  resetComponentOverride,
  resetComponentOverrides,
  selectComponentVariant,
  swapComponentInstance,
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

function addSecondaryButtonComponent(document, page, options = {}) {
  const button = createNode(NODE_TYPES.FRAME, 700, 60, {
    name: "Button / Secondary",
    width: 220,
    height: 64,
    fill: "#2563eb",
  });
  const label = createNode(NODE_TYPES.TEXT, 728, 78, {
    name: options.labelName ?? "Label",
    parentId: button.id,
    width: 164,
    height: 28,
    text: "Secondary",
    fill: "#dbeafe",
    fontSize: 18,
  });
  page.nodes.push(button, label);
  const created = createComponent(document, page.id, [button.id]);
  assert.ok(created.component);
  return { button, label, component: created.component };
}

test("migrates v8 documents to v11 with safe component metadata", () => {
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
  assert.equal(document.version, 11);
  assert.equal(document.components.length, 1);
  assert.equal(getNode(library, "main").componentRole, COMPONENT_ROLES.MAIN);
  assert.equal(getNode(library, "label").componentRole, COMPONENT_ROLES.SOURCE);
  assert.equal(getNode(screen, "instance").componentOverrides.main.x, undefined);
  assert.equal(getNode(screen, "instance").componentOverrides.main.fill, "#10b981");
  assert.deepEqual(getNode(screen, "instance-label").componentOverrides, { label: { text: "unsafe location" } });
});

test("migrates v9 variant records and repairs unsafe component-set membership", () => {
  const document = normalizeDocument({
    version: 9,
    name: "Imported variants",
    pages: [{
      id: "library",
      name: "Library",
      nodes: [
        { id: "default-small", type: "frame", name: "Button / Default small" },
        { id: "hover-large", type: "frame", name: "Button / Hover large" },
        { id: "orphan", type: "frame", name: "Orphan variant" },
      ],
    }],
    componentSets: [
      { id: "buttons", name: "Buttons", propertyNames: ["State", "State", "", "Size"] },
      { id: "lonely", name: "Lonely", propertyNames: [] },
    ],
    components: [
      {
        id: "default",
        name: "Button / Default small",
        sourcePageId: "library",
        sourceNodeId: "default-small",
        componentSetId: "buttons",
        variantProperties: { State: "Default", Size: "Small", Unsafe: "ignored" },
      },
      {
        id: "hover",
        name: "Button / Hover large",
        sourcePageId: "library",
        sourceNodeId: "hover-large",
        componentSetId: "buttons",
        variantProperties: { State: "Hover", Size: "Large" },
      },
      {
        id: "orphan-component",
        name: "Orphan variant",
        sourcePageId: "library",
        sourceNodeId: "orphan",
        componentSetId: "lonely",
        variantProperties: { Variant: "Only" },
      },
    ],
  });

  assert.equal(document.version, 11);
  assert.deepEqual(document.componentSets.map(({ id, propertyNames }) => ({ id, propertyNames })), [
    { id: "buttons", propertyNames: ["State", "Size"] },
  ]);
  assert.deepEqual(document.components[0].variantProperties, { State: "Default", Size: "Small" });
  assert.deepEqual(document.components[1].variantProperties, { State: "Hover", Size: "Large" });
  assert.equal(document.components[2].componentSetId, null);
  assert.deepEqual(document.components[2].variantProperties, {});
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

test("describes overrides and resets one property without disturbing the others", () => {
  const { document, page, label, component } = makeComponentFixture();
  const instance = createComponentInstance(document, component.id, page.id, { x: 360, y: 160 });
  const instanceLabel = page.nodes.find((node) =>
    node.componentSourceId === label.id && node.componentRole === COMPONENT_ROLES.INSTANCE_CHILD);

  instanceLabel.text = "Only here";
  instanceLabel.fill = "#fef3c7";
  recordComponentOverride(document, page, instanceLabel, "text");
  recordComponentOverride(document, page, instanceLabel, "fill");

  const entries = getComponentOverrideEntries(document, page, instance);
  assert.deepEqual(entries.map(({ nodeName, property, value, sourceValue }) => ({
    nodeName,
    property,
    value,
    sourceValue,
  })), [
    { nodeName: "Label", property: "fill", value: "#fef3c7", sourceValue: "#ffffff" },
    { nodeName: "Label", property: "text", value: "Only here", sourceValue: "Continue" },
  ]);

  const resetRoot = resetComponentOverride(document, page, instanceLabel, label.id, "fill");
  assert.equal(resetRoot.id, instance.id);
  assert.equal(getNode(page, instanceLabel.id).fill, "#ffffff");
  assert.equal(getNode(page, instanceLabel.id).text, "Only here");
  assert.deepEqual(getNode(page, instance.id).componentOverrides, {
    [label.id]: { text: "Only here" },
  });
});

test("shadow overrides keep legacy and effect-stack properties synchronized", () => {
  const { document, page, button, component } = makeComponentFixture();
  const instance = createComponentInstance(document, component.id, page.id, { x: 360, y: 160 });
  instance.shadow = {
    enabled: true,
    color: "#112233",
    opacity: 0.5,
    offsetX: 4,
    offsetY: 9,
    blur: 18,
  };
  assert.equal(recordComponentOverride(document, page, instance, "shadow"), true);

  button.fill = "#ef4444";
  syncDocumentComponents(document);
  const synced = getNode(page, instance.id);
  assert.deepEqual(synced.shadow, instance.shadow);
  assert.equal(synced.effects.find((effect) => effect.type === "drop-shadow").blur, 18);
  assert.equal(synced.effects.find((effect) => effect.type === "drop-shadow").visible, true);
});

test("swaps linked instances while preserving placement, ids, and compatible overrides", () => {
  const { document, page, label, component } = makeComponentFixture();
  const secondary = addSecondaryButtonComponent(document, page);
  const instance = createComponentInstance(document, component.id, page.id, { x: 380, y: 220 });
  const instanceLabel = page.nodes.find((node) =>
    node.componentSourceId === label.id && node.componentRole === COMPONENT_ROLES.INSTANCE_CHILD);
  instance.fill = "#f97316";
  instanceLabel.text = "Keep override";
  recordComponentOverride(document, page, instance, "fill");
  recordComponentOverride(document, page, instanceLabel, "text");

  const result = swapComponentInstance(document, page, instanceLabel, secondary.component.id);
  assert.equal(result.error, null);
  assert.equal(result.transferredOverrides, 2);
  assert.equal(result.droppedOverrides, 0);
  assert.equal(result.root.id, instance.id);
  assert.equal(result.root.componentId, secondary.component.id);
  assert.equal(result.root.x, 380);
  assert.equal(result.root.y, 220);
  assert.equal(result.root.fill, "#f97316");

  const swappedLabel = page.nodes.find((node) =>
    node.componentSourceId === secondary.label.id && node.componentRole === COMPONENT_ROLES.INSTANCE_CHILD);
  assert.equal(swappedLabel.id, instanceLabel.id);
  assert.equal(swappedLabel.text, "Keep override");
  assert.equal(getComponentInstanceCount(document, component.id), 0);
  assert.equal(getComponentInstanceCount(document, secondary.component.id), 1);

  secondary.label.text = "Updated secondary";
  secondary.button.stroke = "#172554";
  syncDocumentComponents(document);
  assert.equal(getNode(page, swappedLabel.id).text, "Keep override");
  assert.equal(getNode(page, instance.id).stroke, "#172554");
});

test("drops overrides whose semantic layer does not exist in the swapped component", () => {
  const { document, page, label, component } = makeComponentFixture();
  const secondary = addSecondaryButtonComponent(document, page, { labelName: "Caption" });
  const instance = createComponentInstance(document, component.id, page.id, { x: 380, y: 220 });
  const instanceLabel = page.nodes.find((node) =>
    node.componentSourceId === label.id && node.componentRole === COMPONENT_ROLES.INSTANCE_CHILD);
  instanceLabel.text = "Unmatched override";
  recordComponentOverride(document, page, instanceLabel, "text");

  const result = swapComponentInstance(document, page, instance, secondary.component.id);
  assert.equal(result.transferredOverrides, 0);
  assert.equal(result.droppedOverrides, 1);
  assert.deepEqual(result.root.componentOverrides, {});
  const caption = page.nodes.find((node) =>
    node.componentSourceId === secondary.label.id && node.componentRole === COMPONENT_ROLES.INSTANCE_CHILD);
  assert.equal(caption.text, "Secondary");
});

test("creates a local variant set and switches an instance through variant controls", () => {
  const { document, page, label, component } = makeComponentFixture();
  const secondary = addSecondaryButtonComponent(document, page);
  const created = createComponentSet(document, [component.id, secondary.component.id]);

  assert.equal(created.error, null);
  assert.equal(created.componentSet.name, "Button");
  assert.deepEqual(created.componentSet.propertyNames, ["Variant"]);
  assert.deepEqual(created.components.map((item) => item.variantProperties), [
    { Variant: "Primary" },
    { Variant: "Secondary" },
  ]);

  const instance = createComponentInstance(document, component.id, page.id, { x: 400, y: 240 });
  const instanceLabel = page.nodes.find((node) =>
    node.componentSourceId === label.id && node.componentRole === COMPONENT_ROLES.INSTANCE_CHILD);
  instanceLabel.text = "Variant override";
  recordComponentOverride(document, page, instanceLabel, "text");

  assert.deepEqual(getComponentVariantControls(document, component.id), [{
    propertyName: "Variant",
    value: "Primary",
    options: [
      { value: "Primary", componentId: component.id },
      { value: "Secondary", componentId: secondary.component.id },
    ],
  }]);

  const result = selectComponentVariant(document, page, instance, "Variant", "Secondary");
  assert.equal(result.error, null);
  assert.equal(result.component.id, secondary.component.id);
  assert.equal(result.root.id, instance.id);
  assert.equal(result.root.x, 400);
  assert.equal(result.root.y, 240);
  assert.equal(result.transferredOverrides, 1);
  const swappedLabel = page.nodes.find((node) =>
    node.componentSourceId === secondary.label.id && node.componentRole === COMPONENT_ROLES.INSTANCE_CHILD);
  assert.equal(swappedLabel.text, "Variant override");
});

test("infers multi-property variants and dissolves a component set safely", () => {
  const document = createEmptyDocument("Variant matrix");
  const page = getFirstPage(document);
  const names = [
    "Button / State=Default, Size=Small",
    "Button / State=Hover, Size=Small",
    "Button / State=Default, Size=Large",
    "Button / State=Hover, Size=Large",
  ];
  const componentIds = names.map((name, index) => {
    const node = createNode(NODE_TYPES.FRAME, index * 220, 40, { name, width: 180, height: 56 });
    page.nodes.push(node);
    return createComponent(document, page.id, [node.id]).component.id;
  });

  const created = createComponentSet(document, componentIds);
  assert.deepEqual(created.componentSet.propertyNames, ["State", "Size"]);
  assert.deepEqual(created.components[3].variantProperties, { State: "Hover", Size: "Large" });
  assert.deepEqual(getComponentVariantControls(document, componentIds[0]), [
    {
      propertyName: "State",
      value: "Default",
      options: [
        { value: "Default", componentId: componentIds[0] },
        { value: "Hover", componentId: componentIds[1] },
      ],
    },
    {
      propertyName: "Size",
      value: "Small",
      options: [
        { value: "Small", componentId: componentIds[0] },
        { value: "Large", componentId: componentIds[2] },
      ],
    },
  ]);

  const dissolved = dissolveComponentSet(document, created.componentSet.id);
  assert.equal(dissolved.length, 4);
  assert.deepEqual(document.componentSets, []);
  assert.ok(document.components.every((item) => item.componentSetId === null));
  assert.ok(document.components.every((item) => Object.keys(item.variantProperties).length === 0));
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
