"use strict";
// oc mcp — main thread (figma.* side). No network here.
// Talks only to ui.html via postMessage. UI owns the WebSocket to the bridge.
figma.showUI(__html__, { width: 340, height: 520, title: "oc mcp bridge" });
// Accepts 3, 4, 6, or 8 hex digits (with or without "#"). For 4/8-digit input the
// RGB part is returned and the alpha digit(s) are ignored here. Returns null for
// anything else and NEVER throws (motionKeyframeValue relies on null to pick TEXT_DATA).
function hexToRgb(hex) {
    if (typeof hex !== "string")
        return null;
    const h = hex.replace("#", "").trim();
    const full = h.length === 3 || h.length === 4 ? h.split("").map((c) => c + c).join("") : h;
    if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(full))
        return null;
    const n = parseInt(full.slice(0, 6), 16);
    return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}
function invalidColor(color) {
    let shown;
    try {
        shown = JSON.stringify(color) ?? String(color);
    }
    catch (_e) {
        shown = typeof color;
    }
    return new Error("invalid color: expected #rgb, #rgba, #rrggbb, #rrggbbaa, or {r,g,b}; got " + String(shown).slice(0, 60));
}
// Alpha from a 4/8-digit hex string, or null when the string carries no alpha.
function hexAlpha(hex) {
    if (typeof hex !== "string")
        return null;
    const h = hex.replace("#", "").trim();
    if (/^[0-9a-fA-F]{4}$/.test(h))
        return parseInt(h.slice(3, 4) + h.slice(3, 4), 16) / 255;
    if (/^[0-9a-fA-F]{8}$/.test(h))
        return parseInt(h.slice(6, 8), 16) / 255;
    return null;
}
// Shared alpha resolution so toSolidFill and toRgba can never disagree.
// Order: explicit numeric opacity -> alpha in 4/8-digit hex -> color.a -> 1.
function resolveAlpha(color, opacity) {
    if (typeof opacity === "number")
        return opacity;
    if (typeof color === "string") {
        const a = hexAlpha(color);
        if (a !== null)
            return a;
    }
    if (color && typeof color === "object" && typeof color.a === "number")
        return color.a;
    return 1;
}
function toRgb(color) {
    if (!color)
        return { r: 0.8, g: 0.8, b: 0.8 };
    if (typeof color === "string") {
        const rgb = hexToRgb(color);
        if (rgb)
            return rgb;
        throw invalidColor(color);
    }
    if (typeof color.r === "number" && typeof color.g === "number" && typeof color.b === "number")
        return { r: color.r, g: color.g, b: color.b };
    throw invalidColor(color);
}
function toSolidFill(color, opacity) {
    return { type: "SOLID", color: toRgb(color), opacity: resolveAlpha(color, opacity) };
}
function bytesToBase64(bytes) {
    let s = "";
    const chunk = 8192;
    for (let i = 0; i < bytes.length; i += chunk) {
        s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
    }
    // btoa exists in plugin sandbox
    return globalThis.btoa ? globalThis.btoa(s) : s;
}
async function findNode(id) {
    if (!id)
        return null;
    try {
        return await figma.getNodeByIdAsync(id);
    }
    catch (_e) {
        return null;
    }
}
function safeSerialize(value, depth = 0) {
    if (value === null || value === undefined)
        return value;
    if (typeof value === "symbol")
        return "mixed"; // figma.mixed — postMessage cannot clone symbols
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
        return value;
    if (value instanceof Uint8Array)
        return `<bytes:${value.length}>`;
    if (Array.isArray(value)) {
        if (depth > 6)
            return `[array:${value.length}]`;
        return value.map((v) => safeSerialize(v, depth + 1));
    }
    if (typeof value === "object") {
        if (depth > 6)
            return "[object]";
        const out = {};
        for (const k of Object.keys(value)) {
            try {
                const v = value[k];
                if (typeof v === "function")
                    continue;
                out[k] = safeSerialize(v, depth + 1);
            }
            catch (_e) { /* skip unreadable */ }
        }
        return out;
    }
    return String(value);
}
function clean(v) {
    return typeof v === "symbol" ? "mixed" : v; // figma.mixed (mixed fontSize, cornerRadius, etc.)
}
// Write a property and verify it stuck. Figma silently normalizes some assignments
// (e.g. layoutAlign/layoutGrow on a child whose parent is not auto-layout).
function applyChecked(target, key, value, report) {
    try {
        target[key] = value;
    }
    catch (e) {
        report.mismatched.push({ property: key, requested: value, error: String(e?.message || e) });
        return;
    }
    let after;
    try {
        after = target[key];
    }
    catch (_e) {
        report.applied.push(key);
        return;
    }
    if (sameValue(after, value)) {
        report.applied.push(key);
        return;
    }
    report.mismatched.push({ property: key, requested: value, applied: toSafeValue(after) });
}
function toSafeValue(v) {
    if (v === null || v === undefined)
        return null;
    const t = typeof v;
    if (t === "string" || t === "number" || t === "boolean")
        return v;
    return "mixed"; // Symbols and objects cannot travel through postMessage
}
// Structural comparison for property verification: Figma returns fresh arrays/objects
// (e.g. gridRowSizes entries) and numbers may carry float noise, so `===` gives false mismatches.
function sameValue(a, b) {
    if (a === b)
        return true;
    if (typeof a === "number" && typeof b === "number")
        return Math.abs(a - b) < 1e-6;
    if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length)
            return false;
        for (let i = 0; i < a.length; i++)
            if (!sameValue(a[i], b[i]))
                return false;
        return true;
    }
    if (a && b && typeof a === "object" && typeof b === "object") {
        try {
            return JSON.stringify(a) === JSON.stringify(b);
        }
        catch (_e) {
            return false;
        }
    }
    return false;
}
function detailOf(params) {
    const d = params && params._detail;
    return d === "receipt" || d === "struct" || d === "full" ? d : "full";
}
function serializeNode(node, depth, detail = "full") {
    if (detail === "receipt")
        return { id: node.id, name: node.name, type: node.type };
    const base = {
        id: node.id,
        name: node.name,
        type: node.type,
        visible: clean(node.visible),
        locked: clean(node.locked),
        removed: clean(node.removed),
    };
    try {
        if (typeof node.key === "string")
            base.key = node.key;
    }
    catch (_e) { }
    try {
        if (typeof node.isAsset === "boolean")
            base.isAsset = node.isAsset;
    }
    catch (_e) { }
    try {
        if ("x" in node)
            base.x = clean(node.x);
        if ("y" in node)
            base.y = clean(node.y);
        if ("width" in node)
            base.width = clean(node.width);
        if ("height" in node)
            base.height = clean(node.height);
        if ("rotation" in node)
            base.rotation = clean(node.rotation);
        if ("opacity" in node)
            base.opacity = clean(node.opacity);
        if (detail === "full") {
            if ("fills" in node)
                base.fills = safeSerialize(node.fills);
            if ("strokes" in node)
                base.strokes = safeSerialize(node.strokes);
        }
        if ("strokeWeight" in node)
            base.strokeWeight = clean(node.strokeWeight);
        if ("strokeAlign" in node) {
            try {
                base.strokeAlign = clean(node.strokeAlign);
            }
            catch (_e) { }
        }
        if ("strokeCap" in node) {
            try {
                base.strokeCap = clean(node.strokeCap);
            }
            catch (_e) { }
        }
        if ("strokeJoin" in node) {
            try {
                base.strokeJoin = clean(node.strokeJoin);
            }
            catch (_e) { }
        }
        if ("dashPattern" in node) {
            try {
                base.dashPattern = safeSerialize(node.dashPattern);
            }
            catch (_e) { }
        }
        if ("strokeTopWeight" in node) {
            try {
                base.strokeTopWeight = clean(node.strokeTopWeight);
            }
            catch (_e) { }
        }
        if ("strokeRightWeight" in node) {
            try {
                base.strokeRightWeight = clean(node.strokeRightWeight);
            }
            catch (_e) { }
        }
        if ("strokeBottomWeight" in node) {
            try {
                base.strokeBottomWeight = clean(node.strokeBottomWeight);
            }
            catch (_e) { }
        }
        if ("strokeLeftWeight" in node) {
            try {
                base.strokeLeftWeight = clean(node.strokeLeftWeight);
            }
            catch (_e) { }
        }
        if ("cornerRadius" in node)
            base.cornerRadius = clean(node.cornerRadius);
        if ("topLeftRadius" in node) {
            try {
                base.topLeftRadius = clean(node.topLeftRadius);
            }
            catch (_e) { }
        }
        if ("topRightRadius" in node) {
            try {
                base.topRightRadius = clean(node.topRightRadius);
            }
            catch (_e) { }
        }
        if ("bottomLeftRadius" in node) {
            try {
                base.bottomLeftRadius = clean(node.bottomLeftRadius);
            }
            catch (_e) { }
        }
        if ("bottomRightRadius" in node) {
            try {
                base.bottomRightRadius = clean(node.bottomRightRadius);
            }
            catch (_e) { }
        }
        if ("cornerSmoothing" in node) {
            try {
                base.cornerSmoothing = clean(node.cornerSmoothing);
            }
            catch (_e) { }
        }
        if (detail === "full") {
            if ("effects" in node)
                base.effects = safeSerialize(node.effects);
        }
        if ("layoutMode" in node) {
            base.layoutMode = clean(node.layoutMode);
            base.primaryAxisSizingMode = clean(node.primaryAxisSizingMode);
            base.counterAxisSizingMode = clean(node.counterAxisSizingMode);
            base.primaryAxisAlignItems = clean(node.primaryAxisAlignItems);
            base.counterAxisAlignItems = clean(node.counterAxisAlignItems);
            base.paddingLeft = clean(node.paddingLeft);
            base.paddingRight = clean(node.paddingRight);
            base.paddingTop = clean(node.paddingTop);
            base.paddingBottom = clean(node.paddingBottom);
            base.itemSpacing = clean(node.itemSpacing);
        }
        if ("layoutSizingHorizontal" in node) {
            try {
                base.layoutSizingHorizontal = clean(node.layoutSizingHorizontal);
            }
            catch (_e) { }
        }
        if ("layoutSizingVertical" in node) {
            try {
                base.layoutSizingVertical = clean(node.layoutSizingVertical);
            }
            catch (_e) { }
        }
        if ("constraints" in node) {
            try {
                base.constraints = clean(node.constraints);
            }
            catch (_e) { }
        }
        if ("layoutGrow" in node) {
            try {
                base.layoutGrow = clean(node.layoutGrow);
            }
            catch (_e) { }
        }
        if ("layoutAlign" in node) {
            try {
                base.layoutAlign = clean(node.layoutAlign);
            }
            catch (_e) { }
        }
        if ("layoutPositioning" in node) {
            try {
                base.layoutPositioning = clean(node.layoutPositioning);
            }
            catch (_e) { }
        }
        if ("counterAxisSpacing" in node) {
            try {
                base.counterAxisSpacing = clean(node.counterAxisSpacing);
            }
            catch (_e) { }
        }
        if ("minWidth" in node) {
            try {
                base.minWidth = clean(node.minWidth);
            }
            catch (_e) { }
        }
        if ("maxWidth" in node) {
            try {
                base.maxWidth = clean(node.maxWidth);
            }
            catch (_e) { }
        }
        if ("minHeight" in node) {
            try {
                base.minHeight = clean(node.minHeight);
            }
            catch (_e) { }
        }
        if ("maxHeight" in node) {
            try {
                base.maxHeight = clean(node.maxHeight);
            }
            catch (_e) { }
        }
        if ("strokesIncludedInLayout" in node) {
            try {
                base.strokesIncludedInLayout = clean(node.strokesIncludedInLayout);
            }
            catch (_e) { }
        }
        if (detail === "full") {
            if ("relativeTransform" in node) {
                try {
                    base.relativeTransform = safeSerialize(node.relativeTransform);
                }
                catch (_e) { }
            }
            if ("absoluteTransform" in node) {
                try {
                    base.absoluteTransform = safeSerialize(node.absoluteTransform);
                }
                catch (_e) { }
            }
            if ("absoluteRenderBounds" in node) {
                try {
                    base.absoluteRenderBounds = safeSerialize(node.absoluteRenderBounds);
                }
                catch (_e) { }
            }
            if ("layoutGrids" in node) {
                try {
                    base.layoutGrids = safeSerialize(node.layoutGrids);
                }
                catch (_e) { }
            }
        }
        if ("gridRowCount" in node) {
            try {
                base.gridRowCount = clean(node.gridRowCount);
            }
            catch (_e) { }
        }
        if ("gridColumnCount" in node) {
            try {
                base.gridColumnCount = clean(node.gridColumnCount);
            }
            catch (_e) { }
        }
        if ("gridRowGap" in node) {
            try {
                base.gridRowGap = clean(node.gridRowGap);
            }
            catch (_e) { }
        }
        if ("gridColumnGap" in node) {
            try {
                base.gridColumnGap = clean(node.gridColumnGap);
            }
            catch (_e) { }
        }
        if ("gridRowSizes" in node) {
            try {
                base.gridRowSizes = safeSerialize(node.gridRowSizes);
            }
            catch (_e) { }
        }
        if ("gridColumnSizes" in node) {
            try {
                base.gridColumnSizes = safeSerialize(node.gridColumnSizes);
            }
            catch (_e) { }
        }
        if ("gridAutoTracks" in node) {
            try {
                base.gridAutoTracks = safeSerialize(node.gridAutoTracks);
            }
            catch (_e) { }
        }
        if ("layoutWrap" in node) {
            try {
                base.layoutWrap = clean(node.layoutWrap);
            }
            catch (_e) { }
        }
        if ("counterAxisAlignContent" in node) {
            try {
                base.counterAxisAlignContent = clean(node.counterAxisAlignContent);
            }
            catch (_e) { }
        }
        if ("clipsContent" in node) {
            try {
                base.clipsContent = clean(node.clipsContent);
            }
            catch (_e) { }
        }
        if ("overflowDirection" in node) {
            try {
                base.overflowDirection = clean(node.overflowDirection);
            }
            catch (_e) { }
        }
        if ("itemReverseZIndex" in node) {
            try {
                base.itemReverseZIndex = clean(node.itemReverseZIndex);
            }
            catch (_e) { }
        }
        if ("gridRowAnchor" in node) {
            try {
                base.gridRowAnchor = clean(node.gridRowAnchor);
            }
            catch (_e) { }
        }
        if ("gridRowSpan" in node) {
            try {
                base.gridRowSpan = clean(node.gridRowSpan);
            }
            catch (_e) { }
        }
        if ("gridColumnAnchor" in node) {
            try {
                base.gridColumnAnchor = clean(node.gridColumnAnchor);
            }
            catch (_e) { }
        }
        if ("gridColumnSpan" in node) {
            try {
                base.gridColumnSpan = clean(node.gridColumnSpan);
            }
            catch (_e) { }
        }
        if (node.type === "TEXT") {
            const t = node;
            try {
                const chars = t.characters;
                if (typeof chars === "string") {
                    base.characters = chars.slice(0, 20000);
                    base.charactersTruncated = chars.length > 20000;
                }
            }
            catch (_e) { }
            try {
                base.fontName = safeSerialize(t.fontName);
            }
            catch (_e) { }
            try {
                base.fontSize = clean(t.fontSize);
            }
            catch (_e) { }
            try {
                base.textAlignHorizontal = clean(t.textAlignHorizontal);
            }
            catch (_e) { }
            try {
                base.textAlignVertical = clean(t.textAlignVertical);
            }
            catch (_e) { }
            try {
                base.lineHeight = safeSerialize(t.lineHeight);
            }
            catch (_e) { }
            try {
                base.letterSpacing = safeSerialize(t.letterSpacing);
            }
            catch (_e) { }
            if ("textCase" in t) {
                try {
                    base.textCase = clean(t.textCase);
                }
                catch (_e) { }
            }
            if ("textDecoration" in t) {
                try {
                    base.textDecoration = clean(t.textDecoration);
                }
                catch (_e) { }
            }
            if ("textDecorationStyle" in t) {
                try {
                    base.textDecorationStyle = clean(t.textDecorationStyle);
                }
                catch (_e) { }
            }
            if ("textAutoResize" in t) {
                try {
                    base.textAutoResize = clean(t.textAutoResize);
                }
                catch (_e) { }
            }
            if ("textTruncation" in t) {
                try {
                    base.textTruncation = clean(t.textTruncation);
                }
                catch (_e) { }
            }
            if ("leadingTrim" in t) {
                try {
                    base.leadingTrim = clean(t.leadingTrim);
                }
                catch (_e) { }
            }
            if ("maxLines" in t) {
                try {
                    base.maxLines = clean(t.maxLines);
                }
                catch (_e) { }
            }
            if ("hyperlink" in t) {
                try {
                    base.hyperlink = safeSerialize(t.hyperlink);
                }
                catch (_e) { }
            }
            if ("openTypeFeatures" in t) {
                try {
                    base.openTypeFeatures = safeSerialize(t.openTypeFeatures);
                }
                catch (_e) { }
            }
            if ("paragraphSpacing" in t) {
                try {
                    base.paragraphSpacing = clean(t.paragraphSpacing);
                }
                catch (_e) { }
            }
            if ("paragraphIndent" in t) {
                try {
                    base.paragraphIndent = clean(t.paragraphIndent);
                }
                catch (_e) { }
            }
            if ("listOptions" in t) {
                try {
                    base.listOptions = safeSerialize(t.listOptions);
                }
                catch (_e) { }
            }
            if ("hasMissingFont" in t) {
                try {
                    base.hasMissingFont = clean(t.hasMissingFont);
                }
                catch (_e) { }
            }
            if (detail === "full") {
                try {
                    if (typeof t.getStyledTextSegments === "function") {
                        const segs = t.getStyledTextSegments(["fontSize", "fontName", "fills", "textDecoration", "textCase"]);
                        const arr = Array.isArray(segs) ? segs : [];
                        base.segmentsTruncated = arr.length > 50;
                        base.styledTextSegments = safeSerialize(arr.slice(0, 50));
                    }
                }
                catch (_e) { }
                try {
                    const chars = t.characters;
                    if (typeof chars === "string" && chars.length > 0 && typeof t.getRangeFontSize === "function" && typeof t.getRangeFills === "function") {
                        const n = Math.min(chars.length, 50);
                        const rf = [];
                        const rfl = [];
                        for (let i = 0; i < n; i++) {
                            try {
                                rf.push({ start: i, end: i + 1, fontSize: clean(t.getRangeFontSize(i, i + 1)) });
                            }
                            catch (_e) { }
                            try {
                                rfl.push({ start: i, end: i + 1, fills: safeSerialize(t.getRangeFills(i, i + 1)) });
                            }
                            catch (_e) { }
                        }
                        base.rangeFonts = rf;
                        base.rangeFills = rfl;
                    }
                }
                catch (_e) { }
            }
        }
        if (detail === "full") {
            if ("vectorNetwork" in node) {
                try {
                    const vn = node.vectorNetwork;
                    base.vectorNetwork = safeSerialize(vn);
                    try {
                        const vs = vn?.vertices;
                        if (Array.isArray(vs))
                            base.vertexCount = vs.length;
                    }
                    catch (_e2) { }
                }
                catch (_e) { }
            }
            if ("vectorPaths" in node) {
                try {
                    base.vectorPaths = safeSerialize(node.vectorPaths);
                }
                catch (_e) { }
            }
            if ("fillGeometry" in node) {
                try {
                    base.fillGeometry = safeSerialize(node.fillGeometry);
                }
                catch (_e) { }
            }
            if ("strokeGeometry" in node) {
                try {
                    base.strokeGeometry = safeSerialize(node.strokeGeometry);
                }
                catch (_e) { }
            }
        }
        if ("strokeMiterLimit" in node) {
            try {
                base.strokeMiterLimit = clean(node.strokeMiterLimit);
            }
            catch (_e) { }
        }
        if ("arcData" in node) {
            try {
                base.arcData = safeSerialize(node.arcData);
            }
            catch (_e) { }
        }
        if ("pointCount" in node) {
            try {
                base.pointCount = clean(node.pointCount);
            }
            catch (_e) { }
        }
        if ("booleanOperation" in node) {
            try {
                base.booleanOperation = clean(node.booleanOperation);
            }
            catch (_e) { }
        }
        if (node.type === "COMPONENT" || node.type === "INSTANCE") {
            try {
                base.componentProperties = safeSerialize(node.componentProperties);
            }
            catch (_e) { }
        }
        if (node.type === "INSTANCE") {
            try {
                const mc = node.mainComponent;
                base.mainComponent = mc ? { id: mc.id, name: mc.name, key: clean(mc.key) } : null;
            }
            catch (_e) { }
            if ("variantProperties" in node) {
                try {
                    base.variantProperties = safeSerialize(node.variantProperties);
                }
                catch (_e) { }
            }
            if ("overrides" in node) {
                try {
                    base.overrides = safeSerialize(node.overrides);
                }
                catch (_e) { }
            }
            if (detail === "full" && "exposedInstances" in node) {
                try {
                    const ex = node.exposedInstances;
                    base.exposedInstances = Array.isArray(ex) ? ex.slice(0, 50).map((e) => ({ id: e.id, name: e.name })) : safeSerialize(ex);
                }
                catch (_e) { }
            }
        }
        if ("componentPropertyDefinitions" in node) {
            try {
                base.componentPropertyDefinitions = safeSerialize(node.componentPropertyDefinitions);
            }
            catch (_e) { }
        }
        if ("parent" in node) {
            try {
                const p = node.parent;
                if (p)
                    base.parent = { id: p.id, type: p.type };
            }
            catch (_e) { }
        }
        if ("resolvedVariableModes" in node) {
            try {
                base.resolvedVariableModes = safeSerialize(node.resolvedVariableModes);
            }
            catch (_e) { }
        }
        if ("resolvedModes" in node) {
            try {
                base.resolvedModes = safeSerialize(node.resolvedModes);
            }
            catch (_e) { }
        }
        if ("inferredVariables" in node) {
            try {
                base.inferredVariables = safeSerialize(node.inferredVariables);
            }
            catch (_e) { }
        }
        if ("inferredAutoLayout" in node) {
            try {
                base.inferredAutoLayout = safeSerialize(node.inferredAutoLayout);
            }
            catch (_e) { }
        }
        if ("valuesByMode" in node) {
            try {
                base.valuesByMode = safeSerialize(node.valuesByMode);
            }
            catch (_e) { }
        }
        if ("connectorStart" in node) {
            try {
                base.connectorStart = safeSerialize(node.connectorStart);
            }
            catch (_e) { }
        }
        if ("connectorEnd" in node) {
            try {
                base.connectorEnd = safeSerialize(node.connectorEnd);
            }
            catch (_e) { }
        }
        if ("connectorLineType" in node) {
            try {
                base.connectorLineType = clean(node.connectorLineType);
            }
            catch (_e) { }
        }
        if (node.type === "TABLE") {
            if ("numRows" in node) {
                try {
                    base.numRows = clean(node.numRows);
                }
                catch (_e) { }
            }
            if ("numColumns" in node) {
                try {
                    base.numColumns = clean(node.numColumns);
                }
                catch (_e) { }
            }
        }
        if (node.type === "SECTION" && "sectionContentsHidden" in node) {
            try {
                base.sectionContentsHidden = clean(node.sectionContentsHidden);
            }
            catch (_e) { }
        }
        if (node.type === "SLIDE" && "isSkippedSlide" in node) {
            try {
                base.isSkippedSlide = clean(node.isSkippedSlide);
            }
            catch (_e) { }
        }
        if (node.type === "STICKY" && "isWideWidth" in node) {
            try {
                base.isWideWidth = clean(node.isWideWidth);
            }
            catch (_e) { }
        }
        if (node.type === "CODE_BLOCK") {
            if ("codeLanguage" in node) {
                try {
                    base.codeLanguage = clean(node.codeLanguage);
                }
                catch (_e) { }
            }
            if ("code" in node) {
                try {
                    const c = node.code;
                    base.codeLength = typeof c === "string" ? c.length : 0;
                }
                catch (_e) { }
            }
        }
        if (node.type === "SHAPE_WITH_TEXT" && "shapeType" in node) {
            try {
                base.shapeType = clean(node.shapeType);
            }
            catch (_e) { }
        }
        if (node.type === "EMBED" && "embedData" in node) {
            try {
                base.embedProvider = clean(node.embedData?.provider);
            }
            catch (_e) { }
        }
        if (detail === "full" && "annotations" in node) {
            try {
                const a = node.annotations;
                base.annotationCount = Array.isArray(a) ? a.length : 0;
                base.annotations = Array.isArray(a) ? safeSerialize(a.slice(0, 20)) : safeSerialize(a);
            }
            catch (_e) { }
        }
        if ("widgetId" in node) {
            try {
                base.widgetId = clean(node.widgetId);
            }
            catch (_e) { }
        }
        if ("codeConnectId" in node) {
            try {
                base.codeConnectId = clean(node.codeConnectId);
            }
            catch (_e) { }
        }
        if (detail === "full" && "guides" in node) {
            try {
                const g = node.guides;
                base.guideCount = Array.isArray(g) ? g.length : 0;
                base.guides = Array.isArray(g) ? safeSerialize(g.slice(0, 20)) : safeSerialize(g);
            }
            catch (_e) { }
        }
        if ("blendMode" in node) {
            try {
                base.blendMode = clean(node.blendMode);
            }
            catch (_e) { }
        }
        if ("isMask" in node) {
            try {
                base.isMask = clean(node.isMask);
            }
            catch (_e) { }
        }
        if ("fillStyleId" in node) {
            try {
                base.fillStyleId = clean(node.fillStyleId);
            }
            catch (_e) { }
        }
        if ("strokeStyleId" in node) {
            try {
                base.strokeStyleId = clean(node.strokeStyleId);
            }
            catch (_e) { }
        }
        if ("textStyleId" in node) {
            try {
                base.textStyleId = clean(node.textStyleId);
            }
            catch (_e) { }
        }
        if ("effectStyleId" in node) {
            try {
                base.effectStyleId = clean(node.effectStyleId);
            }
            catch (_e) { }
        }
        if ("boundVariables" in node) {
            try {
                base.boundVariables = safeSerialize(node.boundVariables);
            }
            catch (_e) { }
        }
        if ("explicitVariableModes" in node) {
            try {
                base.explicitVariableModes = safeSerialize(node.explicitVariableModes);
            }
            catch (_e) { }
        }
        if ("reactions" in node) {
            try {
                base.reactions = safeSerialize(node.reactions);
            }
            catch (_e) { }
        }
        if (detail === "full") {
            if ("exportSettings" in node)
                base.exportSettings = safeSerialize(node.exportSettings);
            if ("absoluteBoundingBox" in node)
                base.absoluteBoundingBox = safeSerialize(node.absoluteBoundingBox);
        }
    }
    catch (_e) { /* best effort */ }
    if (depth > 0 && "children" in node && node.children) {
        try {
            base.children = node.children.map((c) => serializeNode(c, depth - 1, detail));
        }
        catch (_e) {
            base.children = [];
        }
    }
    else if ("children" in node && node.children) {
        try {
            base.childCount = node.children.length;
            base.childIds = node.children.map((c) => ({ id: c.id, name: c.name, type: c.type }));
        }
        catch (_e) { }
    }
    return base;
}
async function ensureFont(family = "Inter", style = "Regular") {
    try {
        await figma.loadFontAsync({ family, style });
        return { family, style };
    }
    catch (_e) {
        // fallback to a font we know exists on this node if custom fails
        try {
            const sel = figma.currentPage.selection[0];
            if (sel && sel.type === "TEXT") {
                const fn = sel.fontName;
                if (typeof fn !== "symbol" && fn.family) {
                    await figma.loadFontAsync(fn);
                    return fn;
                }
            }
        }
        catch (_ee) { }
        try {
            await figma.loadFontAsync({ family: "Inter", style: "Regular" });
        }
        catch (_eee) {
            throw new Error("font load failed");
        }
        return { family: "Inter", style: "Regular" };
    }
}
// ---------- command implementations ----------
async function cmdGetDocumentInfo() {
    await figma.currentPage.loadAsync().catch(() => { });
    let pages = [];
    try {
        pages = figma.root.children.map((p) => {
            let childCount = "?";
            try {
                childCount = p.children.length;
            }
            catch (_e) {
                childCount = "unloaded";
            }
            return { id: p.id, name: p.name, childCount };
        });
    }
    catch (_e) {
        pages = [{ error: "could not list pages" }];
    }
    return {
        name: figma.root.name,
        pages,
        currentPage: { id: figma.currentPage.id, name: figma.currentPage.name },
        editorType: (() => { try {
            return figma.editorType;
        }
        catch (_e) {
            return "unknown";
        } })(),
    };
}
async function cmdGetSelection(params) {
    const sel = figma.currentPage.selection;
    return { count: sel.length, nodes: sel.map((n) => serializeNode(n, 3, detailOf(params))) };
}
async function cmdGetNodeTree(params) {
    const depth = Math.min(Math.max(params?.depth ?? 4, 0), 10);
    if (params?.nodeId) {
        const n = await findNode(params.nodeId);
        if (!n)
            throw new Error(`node not found: ${params.nodeId}`);
        return serializeNode(n, depth, detailOf(params));
    }
    await figma.currentPage.loadAsync().catch(() => { });
    return serializeNode(figma.currentPage, depth, detailOf(params));
}
async function cmdGetNodeById(params) {
    if (!params?.nodeId)
        throw new Error("nodeId required");
    const n = await findNode(params.nodeId);
    if (!n)
        throw new Error(`node not found: ${params.nodeId}`);
    const depth = Math.min(Math.max(params?.depth ?? 4, 0), 10);
    return serializeNode(n, depth, detailOf(params));
}
async function cmdGetLocalComponents() {
    await figma.loadAllPagesAsync().catch(() => { });
    const comps = figma.root.findAllWithCriteria({ types: ["COMPONENT", "COMPONENT_SET"] });
    return comps.slice(0, 500).map((c) => ({ id: c.id, name: c.name, type: c.type, page: c.parent?.name }));
}
async function cmdGetLocalStyles() {
    const paints = await figma.getLocalPaintStylesAsync().catch(() => []);
    const texts = await figma.getLocalTextStylesAsync().catch(() => []);
    const effects = await figma.getLocalEffectStylesAsync().catch(() => []);
    const grids = await figma.getLocalGridStylesAsync().catch(() => []);
    return {
        paints: paints.map((s) => ({ id: s.id, name: s.name, paints: safeSerialize(s.paints) })),
        texts: texts.map((s) => ({ id: s.id, name: s.name, fontSize: s.fontSize, fontName: safeSerialize(s.fontName) })),
        effects: effects.map((s) => ({ id: s.id, name: s.name, effects: safeSerialize(s.effects) })),
        grids: grids.slice(0, 50).map((s) => ({ id: s.id, name: s.name })),
    };
}
async function cmdGetLocalVariables() {
    const collections = await figma.variables.getLocalVariableCollectionsAsync().catch(() => []);
    const out = [];
    for (const col of collections) {
        const vars = [];
        for (const id of col.variableIds) {
            try {
                const v = await figma.variables.getVariableByIdAsync(id);
                if (v)
                    vars.push(v);
            }
            catch (_e) { }
        }
        out.push({
            id: col.id, name: col.name, modes: col.modes,
            variables: vars.map((v) => ({ id: v.id, name: v.name, type: v.resolvedType, scopes: v.scopes, valuesByMode: safeSerialize(v.valuesByMode) })),
        });
    }
    return { collections: out };
}
async function cmdExportNode(params) {
    if (!params?.nodeId)
        throw new Error("nodeId required");
    const n = await findNode(params.nodeId);
    if (!n || !("exportAsync" in n))
        throw new Error("node not exportable or not found");
    const format = String(params.format || "PNG").toUpperCase();
    if (format === "MP4" || format === "GIF" || format === "WEBM") {
        const settings = { format };
        const fpsList = format === "GIF" ? [8, 12, 15, 24, 30] : [12, 24, 30, 60];
        if (params.fps !== undefined) {
            if (fpsList.indexOf(params.fps) < 0)
                throw new Error("invalid fps: expected " + fpsList.join("|"));
            settings.fps = params.fps;
        }
        if (params.quality !== undefined) {
            if (format === "GIF")
                throw new Error("invalid quality: GIF has no quality preset");
            if (params.quality !== "LOW" && params.quality !== "MEDIUM" && params.quality !== "HIGH")
                throw new Error("invalid quality: expected LOW|MEDIUM|HIGH");
            settings.quality = params.quality;
        }
        if (params.loopCount !== undefined) {
            if (format !== "GIF")
                throw new Error("invalid loopCount: GIF only");
            if (!Number.isInteger(params.loopCount) || params.loopCount < 0 || params.loopCount > 1000)
                throw new Error("invalid loopCount: expected integer 0..1000");
            settings.loopCount = params.loopCount;
        }
        const bytes = await n.exportAsync(settings);
        const b64 = bytesToBase64(bytes);
        const mime = format === "MP4" ? "video/mp4" : format === "WEBM" ? "video/webm" : "image/gif";
        if (b64.length > 1500000) {
            return { format, nodeId: params.nodeId, truncated: true, base64Length: b64.length, base64: b64.slice(0, 1500000) };
        }
        return { format, nodeId: params.nodeId, base64: b64, mime };
    }
    if (format !== "PNG" && format !== "JPG" && format !== "SVG" && format !== "PDF") {
        throw new Error(`unsupported format: expected PNG/JPG/SVG/PDF/MP4/GIF/WEBM, got ${format}`);
    }
    const scale = Math.min(Math.max(Number(params.scale ?? 2) || 2, 0.5), 4);
    const settings = format === "SVG"
        ? { format: "SVG" }
        : format === "JPG"
            ? { format: "JPG", constraint: { type: "SCALE", value: scale } }
            : format === "PDF"
                ? { format: "PDF" }
                : { format: "PNG", constraint: { type: "SCALE", value: scale } };
    const bytes = await n.exportAsync(settings);
    if (format === "SVG") {
        // exportAsync returns bytes even for SVG; decode as text
        let text = "";
        const chunk = 8192;
        for (let i = 0; i < bytes.length; i += chunk) {
            text += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
        }
        return { format, nodeId: params.nodeId, svg: text.slice(0, 500000) };
    }
    const b64 = bytesToBase64(bytes);
    if (b64.length > 1500000) {
        return { format, nodeId: params.nodeId, truncated: true, base64Length: b64.length, base64: b64.slice(0, 1500000) };
    }
    return { format, nodeId: params.nodeId, base64: b64, mime: format === "PNG" ? "image/png" : format === "JPG" ? "image/jpeg" : "application/pdf" };
}
function placeNode(node, params) {
    const parentId = params?.parentId;
    let parent = figma.currentPage;
    // parentId resolved by caller when async; here sync fallback only
    if (parentId && typeof parentId === "string" && parentId !== "") {
        // best-effort sync lookup among loaded nodes
        try {
            const found = figma.currentPage.findOne((n) => n.id === parentId);
            if (found && "appendChild" in found)
                parent = found;
        }
        catch (_e) { }
    }
    try {
        parent.appendChild(node);
    }
    catch (_e) {
        figma.currentPage.appendChild(node);
    }
    if (typeof params?.x === "number")
        node.x = params.x;
    if (typeof params?.y === "number")
        node.y = params.y;
    if (params?.name)
        node.name = params.name;
}
async function resolveParent(parentId) {
    if (!parentId)
        return figma.currentPage;
    const n = await findNode(parentId);
    if (n && "appendChild" in n)
        return n;
    return figma.currentPage;
}
async function cmdCreateFrame(params) {
    const fillPaint = params?.fill ? toSolidFill(params.fill) : null;
    const f = figma.createFrame();
    f.resize(Math.max(1, params?.width ?? 800), Math.max(1, params?.height ?? 600));
    const parent = await resolveParent(params?.parentId);
    parent.appendChild(f);
    if (typeof params?.x === "number")
        f.x = params.x;
    if (typeof params?.y === "number")
        f.y = params.y;
    if (params?.name)
        f.name = params.name;
    if (fillPaint) {
        try {
            f.fills = [fillPaint];
        }
        catch (e) {
            throw new Error("invalid fill color: " + String(e?.message || e));
        }
    }
    if (params?.layoutMode) {
        try {
            f.layoutMode = params.layoutMode;
        }
        catch (_e) { }
    }
    if (typeof params?.itemSpacing === "number") {
        try {
            f.itemSpacing = params.itemSpacing;
        }
        catch (_e) { }
    }
    if (typeof params?.padding === "number") {
        try {
            f.paddingTop = f.paddingBottom = f.paddingLeft = f.paddingRight = params.padding;
        }
        catch (_e) { }
    }
    if (params?.sizingHorizontal !== undefined) {
        if (params.sizingHorizontal !== "FIXED" && params.sizingHorizontal !== "HUG" && params.sizingHorizontal !== "FILL")
            throw new Error("sizingHorizontal must be FIXED|HUG|FILL");
        try {
            f.layoutSizingHorizontal = params.sizingHorizontal;
        }
        catch (_e) { }
    }
    if (params?.sizingVertical !== undefined) {
        if (params.sizingVertical !== "FIXED" && params.sizingVertical !== "HUG" && params.sizingVertical !== "FILL")
            throw new Error("sizingVertical must be FIXED|HUG|FILL");
        try {
            f.layoutSizingVertical = params.sizingVertical;
        }
        catch (_e) { }
    }
    return serializeNode(f, 1, detailOf(params));
}
async function cmdCreateRectangle(params) {
    const fillPaint = toSolidFill(params?.fill ?? "#D9D9D9");
    const r = figma.createRectangle();
    r.resize(Math.max(1, params?.width ?? 200), Math.max(1, params?.height ?? 120));
    const parent = await resolveParent(params?.parentId);
    parent.appendChild(r);
    if (typeof params?.x === "number")
        r.x = params.x;
    if (typeof params?.y === "number")
        r.y = params.y;
    if (params?.name)
        r.name = params.name;
    try {
        r.fills = [fillPaint];
    }
    catch (e) {
        throw new Error("invalid fill color: " + String(e?.message || e));
    }
    if (typeof params?.cornerRadius === "number") {
        try {
            r.cornerRadius = params.cornerRadius;
        }
        catch (_e) { }
    }
    return serializeNode(r, 0, detailOf(params));
}
async function cmdCreateEllipse(params) {
    const fillPaint = toSolidFill(params?.fill ?? "#D9D9D9");
    const e = figma.createEllipse();
    e.resize(Math.max(1, params?.width ?? 160), Math.max(1, params?.height ?? 160));
    const parent = await resolveParent(params?.parentId);
    parent.appendChild(e);
    if (typeof params?.x === "number")
        e.x = params.x;
    if (typeof params?.y === "number")
        e.y = params.y;
    if (params?.name)
        e.name = params.name;
    try {
        e.fills = [fillPaint];
    }
    catch (e) {
        throw new Error("invalid fill color: " + String(e?.message || e));
    }
    return serializeNode(e, 0, detailOf(params));
}
async function cmdCreateText(params) {
    const family = params?.fontFamily || "Inter";
    const style = params?.fontStyle || "Regular";
    const fillPaint = params?.fill ? toSolidFill(params.fill) : null;
    const loaded = await ensureFont(family, style);
    const t = figma.createText();
    const parent = await resolveParent(params?.parentId);
    parent.appendChild(t);
    try {
        t.fontName = loaded;
    }
    catch (_e) { }
    if (typeof params?.fontSize === "number") {
        try {
            t.fontSize = params.fontSize;
        }
        catch (_e) { }
    }
    t.characters = String(params?.text ?? "Hello");
    if (fillPaint) {
        try {
            t.fills = [fillPaint];
        }
        catch (e) {
            throw new Error("invalid fill color: " + String(e?.message || e));
        }
    }
    if (typeof params?.x === "number")
        t.x = params.x;
    if (typeof params?.y === "number")
        t.y = params.y;
    if (params?.name)
        t.name = params.name;
    try {
        if (params?.align)
            t.textAlignHorizontal = params.align;
    }
    catch (_e) { }
    return serializeNode(t, 0, detailOf(params));
}
async function cmdSetTextContent(params) {
    if (!params?.nodeId)
        throw new Error("nodeId required");
    const n = await findNode(params.nodeId);
    if (!n || n.type !== "TEXT")
        throw new Error("node is not text");
    const t = n;
    const len = t.characters.length;
    if (len === 0) {
        await ensureFont(params?.fontFamily, params?.fontStyle);
    }
    else {
        try {
            const ln = t.getRangeFontName(0, len);
            if (typeof ln !== "object" || !ln.family) {
                await ensureFont(params?.fontFamily, params?.fontStyle);
            }
            else {
                await figma.loadFontAsync(ln);
            }
        }
        catch (_e) {
            await ensureFont(params?.fontFamily, params?.fontStyle);
        }
    }
    if (params?.fontFamily) {
        try {
            t.fontName = { family: params.fontFamily, style: params.fontStyle || "Regular" };
        }
        catch (_e) { }
    }
    t.characters = String(params?.text ?? "");
    return serializeNode(t, 0, detailOf(params));
}
async function cmdSetTextProps(params) {
    if (!params?.nodeId)
        throw new Error("nodeId required");
    const n = await findNode(params.nodeId);
    if (!n || n.type !== "TEXT")
        throw new Error("node is not text");
    const t = n;
    const len = t.characters.length;
    if (len === 0) {
        const fn0 = t.fontName;
        if (typeof fn0 === "object" && fn0 !== null && fn0.family) {
            try {
                await figma.loadFontAsync(fn0);
            }
            catch (e) {
                throw new Error("font not available: " + fn0.family + " " + fn0.style);
            }
        }
        else {
            await ensureFont();
        }
    }
    else {
        const fonts = t.getRangeAllFontNames(0, len);
        for (const fn of fonts) {
            try {
                await figma.loadFontAsync(fn);
            }
            catch (_e) {
                throw new Error("font not available: " + fn.family + " " + fn.style);
            }
        }
    }
    if (params.lineHeight !== undefined) {
        if (params.lineHeight === "AUTO") {
            try {
                if ("lineHeight" in t)
                    t.lineHeight = { unit: "AUTO" };
            }
            catch (e) {
                throw new Error("set lineHeight failed: " + (e instanceof Error ? e.message : String(e)));
            }
        }
        else if (typeof params.lineHeight === "number") {
            try {
                if ("lineHeight" in t)
                    t.lineHeight = { unit: "PIXELS", value: params.lineHeight };
            }
            catch (e) {
                throw new Error("set lineHeight failed: " + (e instanceof Error ? e.message : String(e)));
            }
        }
        else
            throw new Error('invalid lineHeight: expected number (px) or "AUTO"');
    }
    if (params.letterSpacing !== undefined) {
        if (typeof params.letterSpacing !== "number")
            throw new Error("invalid letterSpacing: expected number (px)");
        try {
            if ("letterSpacing" in t)
                t.letterSpacing = { unit: "PIXELS", value: params.letterSpacing };
        }
        catch (e) {
            throw new Error("set letterSpacing failed: " + (e instanceof Error ? e.message : String(e)));
        }
    }
    if (params.textCase !== undefined) {
        if (params.textCase !== "ORIGINAL" && params.textCase !== "UPPER" && params.textCase !== "LOWER" && params.textCase !== "TITLE" && params.textCase !== "SMALL_CAPS" && params.textCase !== "SMALL_CAPS_FORCED")
            throw new Error("invalid textCase: expected ORIGINAL|UPPER|LOWER|TITLE|SMALL_CAPS|SMALL_CAPS_FORCED");
        try {
            if ("textCase" in t)
                t.textCase = params.textCase;
        }
        catch (e) {
            throw new Error("set textCase failed: " + (e instanceof Error ? e.message : String(e)));
        }
    }
    if (params.textDecoration !== undefined) {
        if (params.textDecoration !== "NONE" && params.textDecoration !== "UNDERLINE" && params.textDecoration !== "STRIKETHROUGH")
            throw new Error("invalid textDecoration: expected NONE|UNDERLINE|STRIKETHROUGH");
        try {
            if ("textDecoration" in t)
                t.textDecoration = params.textDecoration;
        }
        catch (e) {
            throw new Error("set textDecoration failed: " + (e instanceof Error ? e.message : String(e)));
        }
    }
    if (params.leadingTrim !== undefined) {
        if (params.leadingTrim !== "NONE" && params.leadingTrim !== "CAP_HEIGHT")
            throw new Error("invalid leadingTrim: expected NONE|CAP_HEIGHT");
        try {
            if ("leadingTrim" in t)
                t.leadingTrim = params.leadingTrim;
        }
        catch (e) {
            throw new Error("set leadingTrim failed: " + (e instanceof Error ? e.message : String(e)));
        }
    }
    if (params.alignVertical !== undefined) {
        if (params.alignVertical !== "TOP" && params.alignVertical !== "CENTER" && params.alignVertical !== "BOTTOM")
            throw new Error("invalid alignVertical: expected TOP|CENTER|BOTTOM");
        try {
            t.textAlignVertical = params.alignVertical;
        }
        catch (e) {
            throw new Error("set alignVertical failed: " + (e instanceof Error ? e.message : String(e)));
        }
    }
    if (params.autoResize !== undefined) {
        if (params.autoResize !== "NONE" && params.autoResize !== "WIDTH_AND_HEIGHT" && params.autoResize !== "HEIGHT" && params.autoResize !== "TRUNCATE")
            throw new Error("invalid autoResize: expected NONE|WIDTH_AND_HEIGHT|HEIGHT|TRUNCATE");
        try {
            t.textAutoResize = params.autoResize;
        }
        catch (e) {
            throw new Error("set autoResize failed: " + (e instanceof Error ? e.message : String(e)));
        }
    }
    if (params.textTruncation !== undefined) {
        if (typeof params.textTruncation !== "boolean")
            throw new Error("invalid textTruncation: expected boolean");
        try {
            if ("textTruncation" in t)
                t.textTruncation = params.textTruncation ? "ENDING" : "DISABLED";
        }
        catch (e) {
            throw new Error("set textTruncation failed: " + (e instanceof Error ? e.message : String(e)));
        }
    }
    if (params.maxLines !== undefined) {
        if (!Number.isInteger(params.maxLines) || !(params.maxLines >= 1))
            throw new Error("invalid maxLines: expected positive int");
        try {
            if ("maxLines" in t)
                t.maxLines = params.maxLines;
        }
        catch (e) {
            throw new Error("set maxLines failed: " + (e instanceof Error ? e.message : String(e)));
        }
    }
    if (params.textWrapStyle !== undefined) {
        if (params.textWrapStyle !== "AUTO" && params.textWrapStyle !== "BALANCE" && params.textWrapStyle !== "PRETTY")
            throw new Error("invalid textWrapStyle: expected AUTO|BALANCE|PRETTY");
        try {
            if ("textWrapStyle" in t)
                t.textWrapStyle = params.textWrapStyle;
        }
        catch (e) {
            throw new Error("set textWrapStyle failed: " + (e instanceof Error ? e.message : String(e)));
        }
    }
    for (const k of ["paragraphSpacing", "paragraphIndent"]) {
        if (params[k] !== undefined) {
            if (typeof params[k] !== "number" || params[k] < 0)
                throw new Error("invalid " + k + ": expected number>=0");
            try {
                t[k] = params[k];
            }
            catch (e) {
                throw new Error("set " + k + " failed: " + (e instanceof Error ? e.message : String(e)));
            }
        }
    }
    if (params.listOptions !== undefined) {
        const lt = typeof params.listOptions === "string" ? params.listOptions : params.listOptions?.type;
        if (lt !== "ORDERED" && lt !== "UNORDERED" && lt !== "NONE")
            throw new Error("invalid listOptions: expected ORDERED|UNORDERED|NONE");
        try {
            t.listOptions = { type: lt };
        }
        catch (e) {
            throw new Error("set listOptions failed: " + (e instanceof Error ? e.message : String(e)));
        }
    }
    return serializeNode(t, 0, detailOf(params));
}
async function cmdSetTextRange(params) {
    if (!params?.nodeId)
        throw new Error("nodeId required");
    const n = await findNode(params.nodeId);
    if (!n || n.type !== "TEXT")
        throw new Error("node is not text");
    const t = n;
    const len = t.characters.length;
    let start = Math.floor(Number(params?.start));
    let end = Math.floor(Number(params?.end));
    if (!Number.isFinite(start) || !Number.isFinite(end))
        throw new Error("start|end required");
    start = Math.min(Math.max(start, 0), len);
    end = Math.min(Math.max(end, 0), len);
    if (start >= end)
        throw new Error("invalid range: expected start<end within [0, characters.length]");
    let loaded = null;
    if (params?.fontFamily !== undefined || params?.fontStyle !== undefined) {
        let family = params?.fontFamily;
        if (!family) {
            try {
                const cur = t.getRangeFontName(start, end);
                if (typeof cur === "object" && cur !== null && cur.family)
                    family = cur.family;
                else {
                    const fn0 = t.fontName;
                    if (typeof fn0 === "object" && fn0 !== null && fn0.family)
                        family = fn0.family;
                }
            }
            catch (_e) { }
        }
        loaded = await ensureFont(family || "Inter", params?.fontStyle || "Regular");
    }
    else {
        try {
            const fonts = t.getRangeAllFontNames(start, end);
            for (const fn of fonts) {
                try {
                    await figma.loadFontAsync(fn);
                }
                catch (_e) {
                    throw new Error("font not available: " + fn.family + " " + fn.style);
                }
            }
            if (!fonts.length)
                await ensureFont();
        }
        catch (e) {
            if (e instanceof Error && e.message.indexOf("font not available") === 0)
                throw e;
            await ensureFont();
        }
    }
    if (params?.fontSize !== undefined) {
        if (typeof params.fontSize !== "number" || !(params.fontSize > 0))
            throw new Error("invalid fontSize: expected number>0");
        try {
            t.setRangeFontSize(start, end, params.fontSize);
        }
        catch (e) {
            throw new Error("set range fontSize failed: " + (e instanceof Error ? e.message : String(e)));
        }
    }
    if (loaded) {
        try {
            t.setRangeFontName(start, end, loaded);
        }
        catch (e) {
            throw new Error("set range font failed: " + (e instanceof Error ? e.message : String(e)));
        }
    }
    if (params?.fill !== undefined) {
        try {
            t.setRangeFills(start, end, [toSolidFill(params.fill)]);
        }
        catch (e) {
            throw new Error("set range fills failed: " + (e instanceof Error ? e.message : String(e)));
        }
    }
    if (params?.styleId !== undefined) {
        if (typeof params.styleId !== "string" || !params.styleId)
            throw new Error("invalid styleId: expected non-empty string");
        try {
            if (typeof t.setRangeTextStyleIdAsync !== "function")
                throw new Error("setRangeTextStyleIdAsync unsupported in this build");
            await t.setRangeTextStyleIdAsync(start, end, params.styleId);
        }
        catch (e) {
            if (e instanceof Error && e.message.indexOf("unsupported") >= 0)
                throw e;
            throw new Error("set range textStyleId failed: " + (e instanceof Error ? e.message : String(e)));
        }
    }
    if (params?.fillStyleId !== undefined) {
        if (typeof params.fillStyleId !== "string" || !params.fillStyleId)
            throw new Error("invalid fillStyleId: expected non-empty string");
        try {
            if (typeof t.setRangeFillStyleIdAsync !== "function")
                throw new Error("setRangeFillStyleIdAsync unsupported in this build");
            await t.setRangeFillStyleIdAsync(start, end, params.fillStyleId);
        }
        catch (e) {
            if (e instanceof Error && e.message.indexOf("unsupported") >= 0)
                throw e;
            throw new Error("set range fillStyleId failed: " + (e instanceof Error ? e.message : String(e)));
        }
    }
    if (params && "link" in params) {
        try {
            if (params.link == null)
                t.setRangeHyperlink(start, end, null);
            else if (typeof params.link === "string") {
                if (!params.link)
                    throw new Error("invalid link: expected URL string or null");
                t.setRangeHyperlink(start, end, { type: "URL", url: params.link });
            }
            else if (typeof params.link === "object") {
                const lt = params.link.type;
                if (lt === "URL") {
                    const url = params.link.url;
                    if (typeof url !== "string" || !url)
                        throw new Error("invalid link: expected {type:URL,url} with non-empty url");
                    t.setRangeHyperlink(start, end, { type: "URL", url });
                }
                else if (lt === "NODE") {
                    const targetId = params.link.nodeId;
                    if (typeof targetId !== "string" || !targetId)
                        throw new Error("invalid link: expected {type:NODE,nodeId}");
                    const target = await findNode(targetId);
                    if (!target)
                        throw new Error("link target not found: " + targetId);
                    t.setRangeHyperlink(start, end, { type: "NODE", value: targetId });
                }
                else
                    throw new Error('invalid link: expected URL string|null or {type:"URL",url}|{type:"NODE",nodeId}');
            }
            else
                throw new Error('invalid link: expected URL string|null or {type:"URL",url}|{type:"NODE",nodeId}');
        }
        catch (e) {
            if (e instanceof Error && (e.message.indexOf("invalid link") === 0 || e.message.indexOf("link target not found") === 0))
                throw e;
            throw new Error("set range hyperlink failed: " + (e instanceof Error ? e.message : String(e)));
        }
    }
    return { id: t.id };
}
async function cmdEditTextChars(params) {
    if (!params?.nodeId)
        throw new Error("nodeId required");
    const n = await findNode(params.nodeId);
    if (!n || n.type !== "TEXT")
        throw new Error("node is not text");
    const t = n;
    const len = t.characters.length;
    if (params?.mode !== "insert" && params?.mode !== "delete")
        throw new Error('invalid mode: expected "insert"|"delete"');
    const start = Math.floor(Number(params?.start));
    if (!Number.isFinite(start) || start < 0 || start > len)
        throw new Error("invalid start: expected 0.." + len);
    try {
        if (len === 0)
            await ensureFont();
        else {
            const fonts = t.getRangeAllFontNames(0, len);
            for (const fn of fonts) {
                try {
                    await figma.loadFontAsync(fn);
                }
                catch (_e) {
                    throw new Error("font not available: " + fn.family + " " + fn.style);
                }
            }
        }
    }
    catch (e) {
        if (e instanceof Error && e.message.indexOf("font not available") === 0)
            throw e;
        await ensureFont();
    }
    try {
        if (params.mode === "insert") {
            if (typeof params?.text !== "string")
                throw new Error("text required for insert");
            if (params.text.length > 20000)
                throw new Error("text capped at 20000 chars");
            t.insertCharacters(start, params.text, "AFTER");
        }
        else {
            const end = Math.floor(Number(params?.end));
            if (!Number.isFinite(end) || end < 0 || end > len)
                throw new Error("invalid end: expected 0.." + len);
            if (start >= end)
                throw new Error("invalid range: expected start<end");
            t.deleteCharacters(start, end);
        }
    }
    catch (e) {
        if (e instanceof Error && (e.message.indexOf("text required") === 0 || e.message.indexOf("invalid ") === 0))
            throw e;
        throw new Error("edit text failed: " + (e instanceof Error ? e.message : String(e)));
    }
    return { id: t.id, characters: t.characters.slice(0, 200) };
}
async function cmdListFonts() {
    let fonts;
    try {
        fonts = await figma.listAvailableFontsAsync();
    }
    catch (e) {
        throw new Error("list fonts failed: " + (e instanceof Error ? e.message : String(e)));
    }
    const out = { fonts: fonts.slice(0, 200).map((f) => ({ family: f.fontName.family, style: f.fontName.style })) };
    if (fonts.length > 200)
        out.truncated = true;
    return out;
}
const TEXT_SEGMENT_FIELDS = ["fontSize", "fontName", "fontWeight", "fills", "textDecoration", "textCase", "lineHeight", "letterSpacing", "hyperlink", "listOptions", "indentation", "paragraphSpacing", "paragraphIndent"];
async function cmdGetTextSegments(params) {
    if (!params?.nodeId)
        throw new Error("nodeId required");
    const n = await findNode(params.nodeId);
    if (!n || n.type !== "TEXT")
        throw new Error("node is not text");
    const t = n;
    let fields = ["fontSize", "fontName", "fills", "textDecoration", "textCase"];
    if (params?.fields !== undefined) {
        if (!Array.isArray(params.fields) || !params.fields.length)
            throw new Error("invalid fields: expected non-empty string[]");
        for (const f of params.fields) {
            if (typeof f !== "string" || TEXT_SEGMENT_FIELDS.indexOf(f) < 0)
                throw new Error("invalid field: " + String(f) + " (expected " + TEXT_SEGMENT_FIELDS.join("|") + ")");
        }
        fields = params.fields.slice(0, 13);
    }
    const len = t.characters.length;
    let start;
    let end;
    if (params?.start !== undefined || params?.end !== undefined) {
        start = Math.floor(Number(params?.start ?? 0));
        end = Math.floor(Number(params?.end ?? len));
        if (!Number.isFinite(start) || !Number.isFinite(end))
            throw new Error("invalid start|end: expected numbers within [0, characters.length]");
        start = Math.min(Math.max(start, 0), len);
        end = Math.min(Math.max(end, 0), len);
        if (start >= end)
            throw new Error("invalid range: expected start<end within [0, characters.length]");
    }
    if (typeof t.getStyledTextSegments !== "function")
        throw new Error("getStyledTextSegments unsupported in this build");
    let segs;
    try {
        segs = start !== undefined && end !== undefined ? t.getStyledTextSegments(fields, start, end) : t.getStyledTextSegments(fields);
    }
    catch (e) {
        throw new Error("getStyledTextSegments failed: " + (e instanceof Error ? e.message : String(e)));
    }
    const arr = Array.isArray(segs) ? segs : [];
    const truncated = arr.length > 50;
    return { id: t.id, length: len, truncated, segments: safeSerialize(truncated ? arr.slice(0, 50) : arr) };
}
async function cmdGetTextList(params) {
    if (!params?.nodeId)
        throw new Error("nodeId required");
    const n = await findNode(params.nodeId);
    if (!n || n.type !== "TEXT")
        throw new Error("node is not text");
    const t = n;
    if (t.characters.length === 0)
        return { type: "NONE" };
    if (typeof t.getRangeListOptions !== "function")
        throw new Error("getRangeListOptions unsupported in this build");
    let raw;
    try {
        raw = t.getRangeListOptions(0, t.characters.length);
    }
    catch (e) {
        throw new Error("getRangeListOptions failed: " + (e instanceof Error ? e.message : String(e)));
    }
    if (typeof raw === "symbol")
        return { type: "mixed" };
    const ty = raw?.type;
    if (ty !== "ORDERED" && ty !== "UNORDERED" && ty !== "NONE")
        return { type: "NONE" };
    return { type: ty };
}
async function cmdSetTextList(params) {
    if (!params?.nodeId)
        throw new Error("nodeId required");
    const n = await findNode(params.nodeId);
    if (!n || n.type !== "TEXT")
        throw new Error("node is not text");
    const t = n;
    if (params.type !== "ORDERED" && params.type !== "UNORDERED" && params.type !== "NONE")
        throw new Error("invalid type: expected ORDERED|UNORDERED|NONE");
    if (typeof t.setRangeListOptions !== "function")
        throw new Error("setRangeListOptions unsupported in this build");
    try {
        t.setRangeListOptions(0, Math.max(t.characters.length, 1), { type: params.type });
    }
    catch (e) {
        throw new Error("setRangeListOptions failed: " + (e instanceof Error ? e.message : String(e)));
    }
    return { nodeId: t.id, type: params.type };
}
function toRgba(color, opacity) {
    const rgb = toRgb(color);
    return { r: rgb.r, g: rgb.g, b: rgb.b, a: resolveAlpha(color, opacity) };
}
function toPaint(f) {
    if (!f || typeof f !== "object")
        return toSolidFill(f);
    const t = String(f.type || "SOLID").toUpperCase();
    if (t === "SOLID")
        return toSolidFill(f.color ?? f, f.opacity);
    const gm = { LINEAR_GRADIENT: "GRADIENT_LINEAR", RADIAL_GRADIENT: "GRADIENT_RADIAL", GRADIENT_LINEAR: "GRADIENT_LINEAR", GRADIENT_RADIAL: "GRADIENT_RADIAL", GRADIENT_ANGULAR: "GRADIENT_ANGULAR", GRADIENT_DIAMOND: "GRADIENT_DIAMOND" };
    if (t === "IMAGE") {
        if (typeof f.imageHash !== "string" || !f.imageHash)
            throw new Error("imageHash required");
        const sm = String(f.scaleMode || "").toUpperCase();
        if (!["FILL", "FIT", "CROP", "TILE"].includes(sm))
            throw new Error("invalid scaleMode: expected FILL|FIT|CROP|TILE");
        return { type: "IMAGE", imageHash: f.imageHash, scaleMode: sm };
    }
    if (!gm[t])
        return f;
    const stops = (f.gradientStops || []).map((s) => ({ position: Math.min(Math.max(Number(s?.position ?? 0), 0), 1), color: toRgba(s?.color, s?.opacity ?? s?.color?.a) }));
    if (!stops.length)
        throw new Error("gradientStops[] required");
    return { type: gm[t], gradientStops: stops, gradientTransform: f.gradientTransform || [[1, 0, 0], [0, 1, 0]] };
}
async function cmdSetFills(params) {
    if (!params?.nodeId)
        throw new Error("nodeId required");
    const n = await findNode(params.nodeId);
    if (!n || !("fills" in n))
        throw new Error("node has no fills");
    // An explicit fills:[] CLEARS fills; omitting `fills` keeps the fill/color/#D9D9D9 shortcut.
    const hasFills = Array.isArray(params?.fills);
    const fills = (hasFills ? params.fills : []).map(toPaint);
    n.fills = hasFills ? fills : [toPaint(params?.fill ?? params?.color ?? "#D9D9D9")];
    return serializeNode(n, 0, detailOf(params));
}
async function cmdSetStrokes(params) {
    if (!params?.nodeId)
        throw new Error("nodeId required");
    const n = await findNode(params.nodeId);
    if (!n || !("strokes" in n))
        throw new Error("node has no strokes");
    if (params.strokes !== undefined)
        n.strokes = (params.strokes || []).map(toPaint);
    const g = n;
    if (typeof params?.strokeWeight === "number" && "strokeWeight" in g) {
        try {
            g.strokeWeight = params.strokeWeight;
        }
        catch (_e) { }
    }
    for (const k of ["strokeTopWeight", "strokeRightWeight", "strokeBottomWeight", "strokeLeftWeight"])
        if (typeof params[k] === "number" && k in g) {
            try {
                g[k] = params[k];
            }
            catch (_e) { }
        }
    if (params.strokeJoin !== undefined) {
        if (!["MITER", "BEVEL", "ROUND"].includes(params.strokeJoin))
            throw new Error("invalid strokeJoin: expected MITER|BEVEL|ROUND");
        if ("strokeJoin" in g)
            g.strokeJoin = params.strokeJoin;
    }
    if (params.strokeCap !== undefined) {
        if (!["NONE", "ROUND", "SQUARE", "ARROW_LINES", "ARROW_EQUILATERAL", "DIAMOND_FILLED", "TRIANGLE_FILLED", "CIRCLE_FILLED"].includes(params.strokeCap))
            throw new Error("invalid strokeCap");
        if ("strokeCap" in g) {
            try {
                g.strokeCap = params.strokeCap;
            }
            catch (_e) { }
        }
    }
    if (params.strokeAlign !== undefined) {
        if (!["CENTER", "INSIDE", "OUTSIDE"].includes(params.strokeAlign))
            throw new Error("invalid strokeAlign: expected CENTER|INSIDE|OUTSIDE");
        if ("strokeAlign" in g) {
            try {
                g.strokeAlign = params.strokeAlign;
            }
            catch (_e) { }
        }
    }
    if (params.strokeMiterLimit !== undefined) {
        if (typeof params.strokeMiterLimit !== "number")
            throw new Error("invalid strokeMiterLimit: expected number");
        if ("strokeMiterLimit" in g) {
            try {
                g.strokeMiterLimit = params.strokeMiterLimit;
            }
            catch (_e) { }
        }
    }
    if (params.dashPattern !== undefined) {
        if (!Array.isArray(params.dashPattern))
            throw new Error("invalid dashPattern: expected number[]");
        if ("dashPattern" in g) {
            try {
                g.dashPattern = params.dashPattern;
            }
            catch (_e) { }
        }
    }
    return serializeNode(n, 0, detailOf(params));
}
async function cmdSetEffects(params) {
    if (!params?.nodeId)
        throw new Error("nodeId required");
    const n = await findNode(params.nodeId);
    if (!n || !("effects" in n))
        throw new Error("node has no effects");
    if (!Array.isArray(params?.effects))
        throw new Error("effects[] required");
    n.effects = params.effects.map((e) => {
        const t = String(e?.type || "").toUpperCase();
        if (t === "LAYER_BLUR" || t === "BACKGROUND_BLUR")
            return { type: t, visible: e.visible ?? true, radius: Number(e.radius ?? 0), blurType: "NORMAL" };
        if (t !== "DROP_SHADOW" && t !== "INNER_SHADOW")
            throw new Error("invalid effect type: expected DROP_SHADOW|INNER_SHADOW|LAYER_BLUR|BACKGROUND_BLUR");
        return { type: t, visible: e.visible ?? true, radius: Number(e.radius ?? 0), color: toRgba(e.color, e.opacity), offset: e.offset ?? { x: 0, y: 0 }, spread: e.spread ?? 0, blendMode: "NORMAL", styleId: e.styleId };
    });
    return serializeNode(n, 0, detailOf(params));
}
async function cmdSetBlendMode(params) {
    if (!params?.nodeId)
        throw new Error("nodeId required");
    if (!["PASS_THROUGH", "NORMAL", "DARKEN", "MULTIPLY", "LINEAR_BURN", "COLOR_BURN", "LIGHTEN", "SCREEN", "LINEAR_DODGE", "COLOR_DODGE", "OVERLAY", "SOFT_LIGHT", "HARD_LIGHT", "DIFFERENCE", "EXCLUSION", "HUE", "SATURATION", "COLOR", "LUMINOSITY"].includes(params.blendMode))
        throw new Error("invalid blendMode");
    const n = await findNode(params.nodeId);
    if (!n || !("blendMode" in n))
        throw new Error("node has no blendMode");
    n.blendMode = params.blendMode;
    return serializeNode(n, 0, detailOf(params));
}
async function findStyleById(id) {
    const all = (await figma.getLocalPaintStylesAsync().catch(() => [])).concat(await figma.getLocalTextStylesAsync().catch(() => []), await figma.getLocalEffectStylesAsync().catch(() => []), await figma.getLocalGridStylesAsync().catch(() => []));
    return all.find((s) => s && s.id === id) || null;
}
async function cmdCreateStyle(params) {
    const kind = String(params?.type || "").toLowerCase();
    if (!params?.name)
        throw new Error("name required");
    if (kind !== "paint" && kind !== "text" && kind !== "effect" && kind !== "grid")
        throw new Error("invalid type: expected paint|text|effect|grid");
    const s = kind === "paint" ? figma.createPaintStyle() : kind === "text" ? figma.createTextStyle() : kind === "effect" ? figma.createEffectStyle() : figma.createGridStyle();
    s.name = params.name;
    return { id: s.id, name: s.name };
}
async function cmdDeleteStyle(params) {
    if (params?.confirm !== true)
        throw new Error("confirm:true required");
    const ids = params?.styleIds || (params?.styleId ? [params.styleId] : []);
    if (ids.length !== 1)
        throw new Error("single styleId required");
    const hit = await findStyleById(ids[0]);
    if (!hit)
        throw new Error("style not found: " + ids[0]);
    const nm = hit.name;
    hit.remove();
    return { deleted: 1, id: ids[0], name: nm, undoHint: "Undo (Ctrl/Cmd+Z) restores the deleted style" };
}
async function cmdRenameStyle(params) {
    if (!params?.styleId || !params?.name)
        throw new Error("styleId|name required");
    const hit = await findStyleById(params.styleId);
    if (!hit)
        throw new Error("style not found: " + params.styleId);
    hit.name = params.name;
    return { id: hit.id, name: hit.name };
}
async function cmdGetStyleById(params) {
    if (!params?.styleId)
        throw new Error("styleId required");
    const id = String(params.styleId);
    const paints = await figma.getLocalPaintStylesAsync().catch(() => []);
    const texts = await figma.getLocalTextStylesAsync().catch(() => []);
    const effects = await figma.getLocalEffectStylesAsync().catch(() => []);
    const grids = await figma.getLocalGridStylesAsync().catch(() => []);
    const hit = paints.concat(texts, effects, grids).find((s) => s && s.id === id);
    if (!hit)
        throw new Error("style not found");
    const out = { id: hit.id, name: hit.name, type: hit.type };
    try {
        if (hit.description)
            out.description = String(hit.description).slice(0, 500);
    }
    catch (_e) { }
    return out;
}
async function cmdImportStyle(params) {
    if (!params?.key)
        throw new Error("key required");
    let s;
    try {
        s = await figma.importStyleByKeyAsync(String(params.key));
    }
    catch (e) {
        throw new Error("import style failed: " + (e instanceof Error ? e.message : String(e)));
    }
    return { id: s.id, name: s.name };
}
async function cmdSetPageBackgrounds(params) {
    if (!params?.nodeId)
        throw new Error("nodeId required");
    const n = await findNode(params.nodeId);
    if (!n || n.type !== "PAGE" || !("backgrounds" in n))
        throw new Error("node is not a page");
    const bg = (params.backgrounds || []).map(toPaint);
    n.backgrounds = bg.length ? bg : [toSolidFill(params?.color ?? "#FFFFFF")];
    if (params.prototypeBackgrounds !== undefined) {
        if (!Array.isArray(params.prototypeBackgrounds))
            throw new Error("prototypeBackgrounds[] required when provided");
        try {
            n.prototypeBackgrounds = params.prototypeBackgrounds.map(toPaint);
        }
        catch (e) {
            throw new Error("set prototypeBackgrounds failed: " + String(e?.message || e));
        }
    }
    return serializeNode(n, 0, detailOf(params));
}
async function cmdSetNodeProps(params) {
    if (!params?.nodeId)
        throw new Error("nodeId required");
    const n = await findNode(params.nodeId);
    if (!n)
        throw new Error("node not found");
    const p = params.props || params;
    const g = n;
    const fillPaint = (p.fill && "fills" in g) ? toSolidFill(p.fill) : null;
    const report = { applied: [], mismatched: [] };
    if (typeof p.x === "number")
        g.x = p.x;
    if (typeof p.y === "number")
        g.y = p.y;
    if (typeof p.width === "number" && typeof p.height === "number" && "resize" in g) {
        try {
            g.resize(p.width, p.height);
            if (sameValue(g.width, p.width) && sameValue(g.height, p.height))
                report.applied.push("resize");
            else
                report.mismatched.push({ property: "resize", requested: [p.width, p.height], applied: { width: toSafeValue(g.width), height: toSafeValue(g.height) } });
        }
        catch (e) {
            report.mismatched.push({ property: "resize", requested: [p.width, p.height], error: String(e?.message || e) });
        }
    }
    if (typeof p.name === "string")
        g.name = p.name;
    if (typeof p.opacity === "number" && "opacity" in g)
        g.opacity = p.opacity;
    if (typeof p.visible === "boolean" && "visible" in g)
        g.visible = p.visible;
    if (typeof p.locked === "boolean" && "locked" in g)
        g.locked = p.locked;
    if (typeof p.cornerRadius === "number" && "cornerRadius" in g)
        applyChecked(g, "cornerRadius", p.cornerRadius, report);
    if (typeof p.cornerSmoothing === "number" && "cornerSmoothing" in g)
        applyChecked(g, "cornerSmoothing", p.cornerSmoothing, report);
    if (fillPaint) {
        try {
            g.fills = [fillPaint];
        }
        catch (e) {
            throw new Error("invalid fill color: " + String(e?.message || e));
        }
    }
    if (typeof p.rotation === "number" && "rotation" in g)
        applyChecked(g, "rotation", p.rotation, report);
    return { ...serializeNode(n, 1, detailOf(params)), applied: report.applied.length, ...(report.mismatched.length ? { mismatched: report.mismatched } : {}) };
}
async function cmdSetLayout(params) {
    if (!params?.nodeId)
        throw new Error("nodeId required");
    const n = await findNode(params.nodeId);
    if (!n || !("layoutMode" in n))
        throw new Error("node has no auto-layout");
    const f = n;
    const report = { applied: [], mismatched: [] };
    // Snapshot child layout state BEFORE any write, so auto-layout's silent
    // normalization of layoutAlign/layoutGrow can be undone afterwards.
    const preserveChildren = params.layoutMode !== undefined && params.preserveChildLayout !== false;
    let snapshots = null;
    if (preserveChildren) {
        snapshots = [];
        try {
            for (const child of (f.children || [])) {
                const values = {};
                for (const key of ["layoutGrow", "layoutAlign", "layoutPositioning"]) {
                    try {
                        if (key in child)
                            values[key] = child[key];
                    }
                    catch (_e) { }
                }
                if (Object.keys(values).length)
                    snapshots.push({ child, values });
            }
        }
        catch (_e) {
            snapshots = null;
        }
    }
    if (params.layoutMode !== undefined) {
        if (!["NONE", "HORIZONTAL", "VERTICAL", "GRID"].includes(params.layoutMode))
            throw new Error("invalid layoutMode: expected NONE|HORIZONTAL|VERTICAL|GRID");
        applyChecked(f, "layoutMode", params.layoutMode, report);
    }
    if (typeof params.itemSpacing === "number")
        applyChecked(f, "itemSpacing", params.itemSpacing, report);
    if (params.counterAxisSpacing !== undefined) {
        if (params.counterAxisSpacing !== null && typeof params.counterAxisSpacing !== "number")
            throw new Error("invalid counterAxisSpacing: expected number|null");
        applyChecked(f, "counterAxisSpacing", params.counterAxisSpacing, report);
    }
    if (typeof params.padding === "number") {
        applyChecked(f, "paddingTop", params.padding, report);
        applyChecked(f, "paddingBottom", params.padding, report);
        applyChecked(f, "paddingLeft", params.padding, report);
        applyChecked(f, "paddingRight", params.padding, report);
    }
    for (const k of ["paddingTop", "paddingBottom", "paddingLeft", "paddingRight"]) {
        if (typeof params[k] === "number")
            applyChecked(f, k, params[k], report);
    }
    if (params.primaryAxisAlignItems)
        applyChecked(f, "primaryAxisAlignItems", params.primaryAxisAlignItems, report);
    if (params.counterAxisAlignItems)
        applyChecked(f, "counterAxisAlignItems", params.counterAxisAlignItems, report);
    if (params.sizingHorizontal !== undefined) {
        if (params.sizingHorizontal !== "FIXED" && params.sizingHorizontal !== "HUG" && params.sizingHorizontal !== "FILL")
            throw new Error("sizingHorizontal must be FIXED|HUG|FILL");
        applyChecked(f, "layoutSizingHorizontal", params.sizingHorizontal, report);
    }
    if (params.sizingVertical !== undefined) {
        if (params.sizingVertical !== "FIXED" && params.sizingVertical !== "HUG" && params.sizingVertical !== "FILL")
            throw new Error("sizingVertical must be FIXED|HUG|FILL");
        applyChecked(f, "layoutSizingVertical", params.sizingVertical, report);
    }
    for (const pair of [["layoutSizingH", "layoutSizingHorizontal"], ["layoutSizingV", "layoutSizingVertical"]]) {
        const val = params[pair[0]] ?? params[pair[1]];
        if (val !== undefined) {
            if (val !== "FIXED" && val !== "HUG" && val !== "FILL")
                throw new Error(pair[0] + " must be FIXED|HUG|FILL");
            applyChecked(f, pair[1], val, report);
        }
    }
    if (params.layoutWrap !== undefined) {
        if (params.layoutWrap !== "NO_WRAP" && params.layoutWrap !== "WRAP")
            throw new Error("layoutWrap must be NO_WRAP|WRAP");
        applyChecked(f, "layoutWrap", params.layoutWrap, report);
    }
    for (const k of ["primaryAxisSizingMode", "counterAxisSizingMode"]) {
        if (params[k] !== undefined) {
            if (params[k] !== "FIXED" && params[k] !== "AUTO")
                throw new Error(k + " must be FIXED|AUTO");
            applyChecked(f, k, params[k], report);
        }
    }
    for (const k of ["minWidth", "maxWidth", "minHeight", "maxHeight"]) {
        if (params[k] !== undefined) {
            if (params[k] !== null && (typeof params[k] !== "number" || !(params[k] >= 0)))
                throw new Error("invalid " + k + ": expected number>=0|null");
            applyChecked(f, k, params[k], report);
        }
    }
    if (params.clipsContent !== undefined)
        applyChecked(f, "clipsContent", !!params.clipsContent, report);
    if (params.gridRowCount !== undefined) {
        if (!Number.isInteger(params.gridRowCount) || params.gridRowCount < 1)
            throw new Error("invalid gridRowCount: expected positive int");
        applyChecked(f, "gridRowCount", params.gridRowCount, report);
    }
    if (params.gridColumnCount !== undefined) {
        if (!Number.isInteger(params.gridColumnCount) || params.gridColumnCount < 1)
            throw new Error("invalid gridColumnCount: expected positive int");
        applyChecked(f, "gridColumnCount", params.gridColumnCount, report);
    }
    if (params.gridRowGap !== undefined) {
        if (typeof params.gridRowGap !== "number" || !(params.gridRowGap >= 0))
            throw new Error("invalid gridRowGap: expected number>=0");
        applyChecked(f, "gridRowGap", params.gridRowGap, report);
    }
    if (params.gridColumnGap !== undefined) {
        if (typeof params.gridColumnGap !== "number" || !(params.gridColumnGap >= 0))
            throw new Error("invalid gridColumnGap: expected number>=0");
        applyChecked(f, "gridColumnGap", params.gridColumnGap, report);
    }
    if (params.gridRowSizes !== undefined) {
        if (!Array.isArray(params.gridRowSizes))
            throw new Error("invalid gridRowSizes: expected array");
        applyChecked(f, "gridRowSizes", params.gridRowSizes, report);
    }
    if (params.gridColumnSizes !== undefined) {
        if (!Array.isArray(params.gridColumnSizes))
            throw new Error("invalid gridColumnSizes: expected array");
        applyChecked(f, "gridColumnSizes", params.gridColumnSizes, report);
    }
    if (params.gridAutoTracks !== undefined) {
        if (params.gridAutoTracks !== "NONE" && params.gridAutoTracks !== "ROWS")
            throw new Error("invalid gridAutoTracks: expected NONE|ROWS");
        applyChecked(f, "gridAutoTracks", params.gridAutoTracks, report);
    }
    // Restore child layout state that auto-layout may have normalized away.
    // Only properties whose current value actually drifted from the snapshot are
    // rewritten; restoredChildren counts those recovered drifted properties (not
    // re-applications of unchanged values).
    let restored = 0;
    if (snapshots) {
        for (const snap of snapshots) {
            try {
                for (const key of Object.keys(snap.values)) {
                    let current;
                    try {
                        current = snap.child[key];
                    }
                    catch (_e) {
                        continue;
                    }
                    if (sameValue(current, snap.values[key]))
                        continue;
                    const restoreReport = { applied: [], mismatched: [] };
                    applyChecked(snap.child, key, snap.values[key], restoreReport);
                    if (restoreReport.applied.length)
                        restored++;
                    for (const mm of restoreReport.mismatched)
                        report.mismatched.push({ ...mm, property: "child[" + snap.child.id + "]." + key });
                }
            }
            catch (_e) { /* child may be gone */ }
        }
    }
    return { ...serializeNode(f, 1, detailOf(params)), applied: report.applied.length, ...(report.mismatched.length ? { mismatched: report.mismatched } : {}), ...(restored ? { restoredChildren: restored } : {}) };
}
async function cmdSetLayoutChild(params) {
    if (!params?.nodeId)
        throw new Error("nodeId required");
    const n = await findNode(params.nodeId);
    if (!n)
        throw new Error("node not found");
    const g = n;
    const report = { applied: [], mismatched: [] };
    if (params.layoutGrow !== undefined) {
        if (typeof params.layoutGrow !== "number")
            throw new Error("invalid layoutGrow: expected number");
        if ("layoutGrow" in g)
            applyChecked(g, "layoutGrow", params.layoutGrow, report);
    }
    if (params.layoutAlign !== undefined) {
        if (params.layoutAlign !== "MIN" && params.layoutAlign !== "CENTER" && params.layoutAlign !== "MAX" && params.layoutAlign !== "STRETCH" && params.layoutAlign !== "INHERIT")
            throw new Error("invalid layoutAlign: expected MIN|CENTER|MAX|STRETCH|INHERIT");
        if ("layoutAlign" in g)
            applyChecked(g, "layoutAlign", params.layoutAlign, report);
    }
    if (params.layoutPositioning !== undefined) {
        if (params.layoutPositioning !== "AUTO" && params.layoutPositioning !== "ABSOLUTE")
            throw new Error("invalid layoutPositioning: expected AUTO|ABSOLUTE");
        if ("layoutPositioning" in g)
            applyChecked(g, "layoutPositioning", params.layoutPositioning, report);
    }
    return { ...serializeNode(n, 0, detailOf(params)), applied: report.applied.length, ...(report.mismatched.length ? { mismatched: report.mismatched } : {}) };
}
async function cmdSetGridChild(params) {
    if (!params?.nodeId)
        throw new Error("nodeId required");
    const row = Math.floor(Number(params?.row));
    const col = Math.floor(Number(params?.column));
    if (!Number.isInteger(row) || row < 0)
        throw new Error("invalid row: expected int>=0");
    if (!Number.isInteger(col) || col < 0)
        throw new Error("invalid column: expected int>=0");
    const n = await findNode(params.nodeId);
    if (!n)
        throw new Error("node not found");
    const g = n;
    const parent = n.parent;
    if (!parent || parent.layoutMode !== "GRID")
        throw new Error("node is not a child of a GRID-layout frame");
    if (typeof g.setGridChildPosition !== "function")
        throw new Error("setGridChildPosition unsupported in this build");
    const report = { applied: [], mismatched: [] };
    try {
        g.setGridChildPosition(row, col);
    }
    catch (e) {
        throw new Error("setGridChildPosition failed: " + (e instanceof Error ? e.message : String(e)));
    }
    if (params.rowSpan !== undefined) {
        if (!Number.isInteger(params.rowSpan) || params.rowSpan < 1)
            throw new Error("invalid rowSpan: expected positive int");
        applyChecked(g, "gridRowSpan", params.rowSpan, report);
    }
    if (params.columnSpan !== undefined) {
        if (!Number.isInteger(params.columnSpan) || params.columnSpan < 1)
            throw new Error("invalid columnSpan: expected positive int");
        applyChecked(g, "gridColumnSpan", params.columnSpan, report);
    }
    for (const pair of [["hAlign", "gridChildHorizontalAlign"], ["vAlign", "gridChildVerticalAlign"]]) {
        const v = params[pair[0]];
        if (v !== undefined) {
            if (v !== "MIN" && v !== "CENTER" && v !== "MAX" && v !== "AUTO")
                throw new Error("invalid " + pair[0] + ": expected MIN|CENTER|MAX|AUTO");
            applyChecked(g, pair[1], v, report);
        }
    }
    return { nodeId: n.id, row, column: col, applied: report.applied.length, ...(report.mismatched.length ? { mismatched: report.mismatched } : {}) };
}
async function cmdSetShapeProps(params) {
    if (!params?.nodeId)
        throw new Error("nodeId required");
    const n = await findNode(params.nodeId);
    if (!n)
        throw new Error("node not found");
    const g = n;
    const t = n.type;
    const hasPoint = params?.pointCount !== undefined;
    const hasInner = params?.innerRadius !== undefined;
    const hasArc = params?.arcData !== undefined;
    if (t === "POLYGON") {
        if (!hasPoint || hasInner || hasArc)
            throw new Error("invalid props for POLYGON: expected pointCount only");
        if (!Number.isInteger(params.pointCount) || params.pointCount < 3)
            throw new Error("invalid pointCount: expected int>=3");
        g.pointCount = params.pointCount;
    }
    else if (t === "STAR") {
        if (hasArc || (!hasPoint && !hasInner))
            throw new Error("invalid props for STAR: expected pointCount and/or innerRadius");
        if (hasPoint) {
            if (!Number.isInteger(params.pointCount) || params.pointCount < 3)
                throw new Error("invalid pointCount: expected int>=3");
            g.pointCount = params.pointCount;
        }
        if (hasInner) {
            if (typeof params.innerRadius !== "number" || params.innerRadius < 0 || params.innerRadius > 1)
                throw new Error("invalid innerRadius: expected 0..1");
            g.innerRadius = params.innerRadius;
        }
    }
    else if (t === "ELLIPSE") {
        if (!hasArc || hasPoint || hasInner)
            throw new Error("invalid props for ELLIPSE: expected arcData only");
        const a = params.arcData;
        if (!a || typeof a !== "object" || typeof a.startingAngle !== "number" || typeof a.endingAngle !== "number")
            throw new Error("invalid arcData: expected {startingAngle:number,endingAngle:number,innerRadius?}");
        if (a.innerRadius !== undefined && typeof a.innerRadius !== "number")
            throw new Error("invalid arcData.innerRadius: expected number");
        const cur = g.arcData;
        g.arcData = { startingAngle: a.startingAngle, endingAngle: a.endingAngle, innerRadius: a.innerRadius ?? (cur ? cur.innerRadius : 0) };
    }
    else
        throw new Error("node is not POLYGON|STAR|ELLIPSE");
    return { nodeId: n.id };
}
async function cmdSetAspectLock(params) {
    if (!params?.nodeId)
        throw new Error("nodeId required");
    if (typeof params?.locked !== "boolean")
        throw new Error("invalid locked: expected boolean");
    const n = await findNode(params.nodeId);
    if (!n)
        throw new Error("node not found");
    const g = n;
    try {
        if (params.locked) {
            if (typeof g.lockAspectRatio !== "function")
                throw new Error("lockAspectRatio unsupported in this build");
            g.lockAspectRatio();
        }
        else {
            if (typeof g.unlockAspectRatio !== "function")
                throw new Error("unlockAspectRatio unsupported in this build");
            g.unlockAspectRatio();
        }
    }
    catch (e) {
        if (e instanceof Error && e.message.indexOf("unsupported") >= 0)
            throw e;
        throw new Error("set aspect lock failed: " + (e instanceof Error ? e.message : String(e)));
    }
    return { nodeId: n.id, locked: params.locked };
}
async function cmdGetTransform(params) {
    if (!params?.nodeId)
        throw new Error("nodeId required");
    const n = await findNode(params.nodeId);
    if (!n)
        throw new Error("node not found");
    const g = n;
    let relativeTransform = null;
    let absoluteTransform = null;
    try {
        relativeTransform = safeSerialize(g.relativeTransform);
    }
    catch (_e) { }
    try {
        absoluteTransform = safeSerialize(g.absoluteTransform);
    }
    catch (_e) { }
    return { relativeTransform, absoluteTransform };
}
async function cmdGetPluginInfo() {
    const pick = (fn) => { try {
        const v = fn();
        return typeof v === "string" && v ? v : "unknown";
    }
    catch (_e) {
        return "unknown";
    } };
    return { apiVersion: pick(() => figma.apiVersion), mode: pick(() => figma.mode), fileKey: pick(() => figma.fileKey), editorType: pick(() => figma.editorType) };
}
async function cmdGetNodeBinds(params) {
    if (!params?.nodeId)
        throw new Error("nodeId required");
    const n = await findNode(params.nodeId);
    if (!n)
        throw new Error(`node not found: ${params.nodeId}`);
    let boundVariables = null;
    let inferredVariables = null;
    let resolvedVariableModes = null;
    try {
        boundVariables = safeSerialize(n.boundVariables ?? null);
    }
    catch (_e) {
        boundVariables = null;
    }
    try {
        inferredVariables = safeSerialize(n.inferredVariables ?? null);
    }
    catch (_e) {
        inferredVariables = null;
    }
    try {
        resolvedVariableModes = safeSerialize(n.resolvedVariableModes ?? null);
    }
    catch (_e) {
        resolvedVariableModes = null;
    }
    return { boundVariables, inferredVariables, resolvedVariableModes };
}
async function cmdGetVectorGeometry(params) {
    if (!params?.nodeId)
        throw new Error("nodeId required");
    const n = await findNode(params.nodeId);
    if (!n)
        throw new Error(`node not found: ${params.nodeId}`);
    const one = (k) => { try {
        const v = n[k];
        return v === undefined ? null : safeSerialize(v);
    }
    catch (_e) {
        return null;
    } };
    return { fillGeometry: one("fillGeometry"), strokeGeometry: one("strokeGeometry"), vectorPaths: one("vectorPaths") };
}
async function cmdSetNodeDescription(params) {
    if (!params?.nodeId)
        throw new Error("nodeId required");
    let target = await findNode(params.nodeId);
    if (!target)
        target = await findStyleById(String(params.nodeId));
    if (!target)
        throw new Error(`node not found: ${params.nodeId}`);
    const out = { id: target.id };
    if (params?.description !== undefined) {
        if (typeof params.description !== "string")
            throw new Error("invalid description: expected string");
        target.description = params.description.slice(0, 2000);
        out.description = target.description;
    }
    if (params?.links !== undefined) {
        if (!Array.isArray(params.links))
            throw new Error("invalid links: expected array of {uri} strings");
        const docs = params.links.map((l) => typeof l === "string" ? l : l?.uri);
        for (const u of docs) {
            if (typeof u !== "string" || !/^https?:\/\//.test(u))
                throw new Error("invalid links: each uri must be http(s) URL");
        }
        try {
            target.documentationLinks = docs.map((uri) => ({ uri }));
            out.linksApplied = true;
        }
        catch (_e) {
            out.linksApplied = false;
        }
    }
    return out;
}
async function cmdSetDevStatus(params) {
    if (!params?.nodeId)
        throw new Error("nodeId required");
    if (!("status" in (params || {})))
        throw new Error("status required (null clears)");
    const n = await findNode(params.nodeId);
    if (!n)
        throw new Error(`node not found: ${params.nodeId}`);
    const s = params.status;
    if (s !== null) {
        if (!s || typeof s !== "object")
            throw new Error("invalid status: expected null or {type, description?}");
        if (s.type !== "READY_FOR_DEV" && s.type !== "COMPLETED")
            throw new Error("invalid status.type: expected READY_FOR_DEV|COMPLETED");
        if (s.description !== undefined && typeof s.description !== "string")
            throw new Error("invalid status.description: expected string");
    }
    try {
        n.devStatus = s === null ? null : { type: s.type, ...(s.description !== undefined ? { description: s.description } : {}) };
    }
    catch (e) {
        throw new Error("set devStatus failed: " + (e instanceof Error ? e.message : String(e)));
    }
    return { id: n.id, status: n.devStatus ?? null };
}
async function cmdDeleteNodes(params) {
    const ids = params?.nodeIds || (params?.nodeId ? [params.nodeId] : []);
    if (ids.length > 100)
        throw new Error("nodeIds[] limit is 100");
    let deleted = 0;
    for (const id of ids) {
        const n = await findNode(id);
        if (n && (n.type === "PAGE" || n.type === "DOCUMENT"))
            throw new Error("refuse to delete PAGE/DOCUMENT via delete_nodes — use delete_page with confirm:true");
        if (n) {
            try {
                n.remove();
                deleted++;
            }
            catch (_e) { }
        }
    }
    return { deleted };
}
async function cmdFlattenNodes(params) {
    if (!Array.isArray(params?.nodeIds))
        throw new Error("nodeIds[] required");
    const ids = params.nodeIds;
    if (ids.length < 2)
        throw new Error("need >=2 nodes");
    if (ids.length > 100)
        throw new Error("nodeIds[] limit is 100");
    const nodes = [];
    for (const id of ids) {
        const n = await findNode(id);
        if (!n)
            throw new Error("node not found: " + id);
        if (n.type === "PAGE" || n.type === "DOCUMENT")
            throw new Error("refuse to flatten PAGE/DOCUMENT via flatten_nodes");
        nodes.push(n);
    }
    const parent = nodes[0].parent;
    if (!parent || typeof parent.appendChild !== "function")
        throw new Error("nodes have no parent");
    const result = figma.flatten(nodes, parent);
    return { id: result.id };
}
async function cmdRescaleNode(params) {
    if (!params?.nodeId)
        throw new Error("nodeId required");
    const scale = Number(params?.scale);
    if (!Number.isFinite(scale) || !(scale > 0))
        throw new Error("invalid scale: expected number>0");
    if (scale > 100)
        throw new Error("invalid scale: capped at 100");
    const n = await findNode(params.nodeId);
    if (!n)
        throw new Error("node not found");
    try {
        n.rescale(scale);
    }
    catch (e) {
        throw new Error("rescale failed: " + (e instanceof Error ? e.message : String(e)));
    }
    return { id: n.id, scale };
}
async function cmdOutlineStroke(params) {
    if (!params?.nodeId)
        throw new Error("nodeId required");
    const n = await findNode(params.nodeId);
    if (!n)
        throw new Error("node not found");
    if (typeof n.outlineStroke !== "function")
        throw new Error("outlineStroke unsupported on this node");
    let v = null;
    try {
        v = n.outlineStroke();
    }
    catch (e) {
        throw new Error("outline failed: " + (e instanceof Error ? e.message : String(e)));
    }
    if (!v)
        throw new Error("outline failed");
    return { id: v.id };
}
async function cmdCreateTextPath(params) {
    if (!params?.nodeId)
        throw new Error("nodeId required");
    const n = await findNode(params.nodeId);
    if (!n)
        throw new Error("node not found");
    if (n.type !== "VECTOR")
        throw new Error("node is not a vector");
    const seg = params?.startSegment ?? 0;
    const pos = params?.startPosition ?? 0.5;
    if (!Number.isFinite(Number(seg)) || Number(seg) < 0)
        throw new Error("invalid startSegment: expected number>=0");
    if (!Number.isFinite(Number(pos)) || Number(pos) < 0 || Number(pos) > 1)
        throw new Error("invalid startPosition: expected 0..1");
    try {
        const tp = figma.createTextPath(n, Math.floor(Number(seg)), Number(pos));
        return { id: tp.id };
    }
    catch (e) {
        throw new Error("createTextPath failed: " + (e instanceof Error ? e.message : String(e)));
    }
}
async function cmdSetLayoutGrids(params) {
    if (!params?.nodeId)
        throw new Error("nodeId required");
    if (!Array.isArray(params?.grids))
        throw new Error("grids[] required");
    if (params.grids.length > 50)
        throw new Error("grids capped at 50");
    const n = await findNode(params.nodeId);
    if (!n || !("layoutGrids" in n))
        throw new Error("node has no layout grids");
    const normalized = params.grids.map((g) => {
        if (!g || typeof g !== "object" || (g.pattern !== "ROWS" && g.pattern !== "COLUMNS" && g.pattern !== "GRID"))
            throw new Error("invalid grid: expected pattern ROWS|COLUMNS|GRID");
        if (g.pattern === "GRID")
            return { sectionSize: 100, ...g };
        return { alignment: "STRETCH", gutterSize: 24, count: 12, offset: 0, ...g };
    });
    try {
        n.layoutGrids = normalized;
    }
    catch (e) {
        throw new Error("set layoutGrids failed: " + (e instanceof Error ? e.message : String(e)));
    }
    return { id: n.id, count: normalized.length };
}
async function cmdGetSelectionColors(_params) {
    if (typeof figma.getSelectionColors !== "function")
        return { colors: [] };
    let res = null;
    try {
        res = figma.getSelectionColors();
    }
    catch (_e) {
        return { colors: [] };
    }
    if (!res || !Array.isArray(res.paints))
        return { colors: [] };
    return { colors: safeSerialize(res.paints.slice(0, 50)) };
}
const FIND_NODE_TYPES = ["FRAME", "TEXT", "RECTANGLE", "ELLIPSE", "COMPONENT", "INSTANCE", "GROUP", "VECTOR", "POLYGON", "STAR", "LINE"];
function findNodePath(node) {
    try {
        const names = [];
        let cur = node ? node.parent : null;
        let level = 0;
        let truncated = false;
        while (cur && cur.type !== "PAGE") {
            if (level >= 6) {
                truncated = true;
                break;
            }
            if (typeof cur.name === "string")
                names.push(cur.name);
            level++;
            cur = cur.parent;
        }
        const path = names.reverse().join(" / ");
        return truncated ? "… / " + path : path;
    }
    catch (_e) {
        return "";
    }
}
function findNodeCharacters(node) {
    try {
        return typeof node.characters === "string" ? node.characters : null;
    }
    catch (_e) {
        return null;
    }
}
async function cmdFindNodes(params) {
    let parent = figma.currentPage;
    if (params?.parentId) {
        const p = await findNode(params.parentId);
        if (!p)
            throw new Error("parent not found: " + params.parentId);
        parent = p;
    }
    if (typeof parent.findAll !== "function")
        throw new Error("parent has no children");
    const nameSub = typeof params?.nameContains === "string" && params.nameContains ? params.nameContains.toLowerCase() : null;
    const textSub = typeof params?.textContains === "string" && params.textContains ? params.textContains.toLowerCase() : null;
    const wantEmptyText = params?.textEmpty === true;
    let limit = 100;
    if (params?.limit !== undefined) {
        const rawLimit = params.limit;
        if (typeof rawLimit !== "number" || !Number.isFinite(rawLimit) || !Number.isInteger(rawLimit))
            throw new Error("invalid limit: expected number 1..1000");
        limit = Math.max(1, Math.min(1000, rawLimit));
    }
    let matches;
    const criteria = {};
    if (params?.types !== undefined) {
        if (!Array.isArray(params.types))
            throw new Error("invalid types: expected string[]");
        const types = params.types.map((t) => String(t).toUpperCase());
        for (const t of types)
            if (FIND_NODE_TYPES.indexOf(t) < 0)
                throw new Error("invalid type: " + t + " (expected " + FIND_NODE_TYPES.join("|") + ")");
        criteria.types = types;
    }
    if (params?.pluginData !== undefined) {
        const pd = params.pluginData;
        if (typeof pd !== "object" || pd === null)
            throw new Error("invalid pluginData: expected object");
        if (pd.keys !== undefined && !Array.isArray(pd.keys))
            throw new Error("invalid pluginData.keys: expected string[]");
        criteria.pluginData = pd.keys !== undefined ? { keys: pd.keys.map(String) } : {};
    }
    if (params?.sharedPluginData !== undefined) {
        const sp = params.sharedPluginData;
        if (typeof sp !== "object" || sp === null || typeof sp.namespace !== "string" || !sp.namespace)
            throw new Error("sharedPluginData.namespace (string) required");
        if (sp.keys !== undefined && !Array.isArray(sp.keys))
            throw new Error("invalid sharedPluginData.keys: expected string[]");
        criteria.sharedPluginData = sp.keys !== undefined ? { namespace: sp.namespace, keys: sp.keys.map(String) } : { namespace: sp.namespace };
    }
    const useCriteria = params?.types !== undefined || params?.pluginData !== undefined || params?.sharedPluginData !== undefined;
    try {
        matches = useCriteria ? parent.findAllWithCriteria(criteria) : parent.findAll(() => true);
    }
    catch (e) {
        throw new Error("find failed: " + (e instanceof Error ? e.message : String(e)));
    }
    if (nameSub)
        matches = matches.filter((m) => String(m.name || "").toLowerCase().indexOf(nameSub) >= 0);
    if (textSub)
        matches = matches.filter((m) => m.type === "TEXT" && (findNodeCharacters(m) || "").toLowerCase().indexOf(textSub) >= 0);
    if (wantEmptyText)
        matches = matches.filter((m) => m.type === "TEXT" && (findNodeCharacters(m) || "").trim() === "");
    const total = matches.length;
    const limited = matches.slice(0, limit);
    const result = limited.map((m) => ({ id: m.id, name: m.name, type: m.type, path: findNodePath(m) }));
    return { total, returned: result.length, truncated: total > result.length, matches: result };
}
async function cmdCloneNode(params) {
    if (!params?.nodeId)
        throw new Error("nodeId required");
    const n = await findNode(params.nodeId);
    if (!n || !("clone" in n))
        throw new Error("node not clonable");
    const c = n.clone();
    const parent = await resolveParent(params?.parentId);
    parent.appendChild(c);
    if (typeof params?.x === "number")
        c.x = params.x;
    if (typeof params?.y === "number")
        c.y = params.y;
    return serializeNode(c, 1, detailOf(params));
}
async function cmdMoveNode(params) {
    if (!params?.nodeId)
        throw new Error("nodeId required");
    const n = await findNode(params.nodeId);
    if (!n)
        throw new Error("node not found");
    const parent = await resolveParent(params?.parentId);
    try {
        parent.insertChild(typeof params?.index === "number" ? params.index : parent.children.length, n);
    }
    catch (_e) {
        throw new Error("move failed: parent cannot contain this node");
    }
    return serializeNode(n, 0, detailOf(params));
}
async function cmdSetSelection(params) {
    const ids = params?.nodeIds || [];
    if (ids.length > 100)
        throw new Error("nodeIds[] limit is 100");
    const nodes = [];
    for (const id of ids) {
        const n = await findNode(id);
        if (n && "id" in n && n.type !== "PAGE" && n.type !== "DOCUMENT")
            nodes.push(n);
    }
    figma.currentPage.selection = nodes;
    // Never move the user's camera unless explicitly asked — keeps their view stable while they work in parallel.
    if (params?.scrollIntoView === true) {
        try {
            if (nodes.length)
                figma.viewport.scrollAndZoomIntoView(nodes);
        }
        catch (_e) { }
    }
    return { count: nodes.length };
}
async function cmdScrollToNode(params) {
    const raw = params?.nodeIds || (params?.nodeId ? [params.nodeId] : []);
    const nodes = [];
    for (const id of raw) {
        const n = await findNode(id);
        if (n && "id" in n && n.type !== "PAGE" && n.type !== "DOCUMENT")
            nodes.push(n);
    }
    if (!nodes.length)
        throw new Error("node not found");
    figma.viewport.scrollAndZoomIntoView(nodes);
    return { count: nodes.length };
}
async function cmdAddToSelection(params) {
    const ids = params?.nodeIds || [];
    if (ids.length > 100)
        throw new Error("nodeIds[] limit is 100");
    const nodes = [];
    for (const id of ids) {
        const n = await findNode(id);
        if (!n)
            throw new Error("node not found: " + id);
        if (n.type === "PAGE" || n.type === "DOCUMENT")
            continue;
        nodes.push(n);
    }
    const merged = new Map();
    for (const n of figma.currentPage.selection)
        merged.set(n.id, n);
    for (const n of nodes)
        merged.set(n.id, n);
    const next = Array.from(merged.values());
    figma.currentPage.selection = next;
    if (params?.scrollIntoView === true) {
        try {
            if (next.length)
                figma.viewport.scrollAndZoomIntoView(next);
        }
        catch (_e) { }
    }
    return { count: next.length };
}
async function cmdClearSelection(_params) {
    figma.currentPage.selection = [];
    return { count: 0 };
}
async function cmdGetCanvasView(_params) {
    const v = figma.viewport;
    return { center: { x: v.center.x, y: v.center.y }, zoom: v.zoom, bounds: { x: v.bounds.x, y: v.bounds.y, width: v.bounds.width, height: v.bounds.height } };
}
async function cmdCreatePage(params) {
    const p = figma.createPage();
    p.name = params?.name || "New page";
    try {
        await p.loadAsync();
    }
    catch (_e) { }
    if (params?.select)
        await figma.setCurrentPageAsync(p);
    return { id: p.id, name: p.name };
}
async function cmdPageOps(params) {
    const action = String(params?.action || "").toLowerCase();
    const page = figma.currentPage;
    try {
        await page.loadAsync();
    }
    catch (_e) { }
    if (action === "rename") {
        const name = String(params?.name ?? "").trim();
        if (!name)
            throw new Error("name required");
        page.name = name;
        return { id: page.id, name: page.name };
    }
    if (action === "duplicate") {
        if (typeof page.clone !== "function")
            throw new Error("page duplicate unsupported in this editor");
        const dup = page.clone();
        try {
            await dup.loadAsync();
        }
        catch (_e) { }
        if (params?.name)
            dup.name = params.name;
        return { id: dup.id, name: dup.name };
    }
    if (action === "background") {
        if (params?.color === undefined)
            throw new Error("color required");
        try {
            page.backgrounds = [toSolidFill(params.color)];
        }
        catch (e) {
            throw new Error("set background failed: " + String(e?.message || e));
        }
        return { id: page.id, name: page.name };
    }
    throw new Error("invalid action: expected rename|duplicate|background");
}
async function cmdGroupNodes(params) {
    const ids = params?.nodeIds || [];
    if (ids.length > 100)
        throw new Error("nodeIds[] limit is 100");
    const nodes = [];
    for (const id of ids) {
        const n = await findNode(id);
        if (n && n.type !== "PAGE")
            nodes.push(n);
    }
    if (!nodes.length)
        throw new Error("no nodes to group");
    const parent = params?.parentId ? await resolveParent(params.parentId) : nodes[0].parent;
    const g = figma.group(nodes, parent);
    if (params?.name)
        g.name = params.name;
    return serializeNode(g, 1, detailOf(params));
}
async function cmdCreateComponent(params) {
    let comp;
    if (params?.fromNodeId) {
        const n = await findNode(params.fromNodeId);
        if (!n || !("type" in n))
            throw new Error("source node not found");
        comp = figma.createComponentFromNode(n);
    }
    else {
        comp = figma.createComponent();
        comp.resize(params?.width ?? 200, params?.height ?? 120);
        const parent = await resolveParent(params?.parentId);
        parent.appendChild(comp);
    }
    if (params?.name)
        comp.name = params.name;
    return serializeNode(comp, 1, detailOf(params));
}
async function cmdCreateInstance(params) {
    if (!params?.componentId)
        throw new Error("componentId required");
    const c = await findNode(params.componentId);
    if (!c || (c.type !== "COMPONENT" && c.type !== "COMPONENT_SET"))
        throw new Error("not a component");
    const inst = c.createInstance();
    const parent = await resolveParent(params?.parentId);
    parent.appendChild(inst);
    if (typeof params?.x === "number")
        inst.x = params.x;
    if (typeof params?.y === "number")
        inst.y = params.y;
    return serializeNode(inst, 1, detailOf(params));
}
async function cmdSetInstanceProps(params) {
    if (!params?.nodeId)
        throw new Error("nodeId required");
    const n = await findNode(params.nodeId);
    if (!n || (n.type !== "INSTANCE" && n.type !== "COMPONENT_SET"))
        throw new Error("not an instance");
    const props = params.properties;
    if (!props || typeof props !== "object")
        throw new Error("properties required");
    const applied = [], skipped = [];
    for (const k of Object.keys(props)) {
        try {
            if (typeof n.setProperties === "function")
                n.setProperties({ [k]: props[k] });
            else
                n.componentProperties = Object.assign({}, n.componentProperties, { [k]: props[k] });
            applied.push(k);
        }
        catch (_e) {
            skipped.push(k);
        }
    }
    return { nodeId: n.id, applied, skipped };
}
async function cmdSwapInstance(params) {
    if (!params?.nodeId || !params?.componentId)
        throw new Error("nodeId|componentId required");
    const n = await findNode(params.nodeId);
    if (!n || n.type !== "INSTANCE")
        throw new Error("not an instance");
    const c = await findNode(params.componentId);
    if (!c || (c.type !== "COMPONENT" && c.type !== "COMPONENT_SET"))
        throw new Error("not a component");
    if (typeof n.swapComponent !== "function")
        throw new Error("swap unsupported on this node");
    const target = c.type === "COMPONENT_SET" ? (c.defaultVariant || c) : c;
    try {
        n.swapComponent(target);
    }
    catch (e) {
        throw new Error("swap failed: " + String(e?.message || e));
    }
    return serializeNode(n, 1, detailOf(params));
}
async function cmdDetachInstance(params) {
    if (!params?.nodeId)
        throw new Error("nodeId required");
    const n = await findNode(params.nodeId);
    if (!n || n.type !== "INSTANCE")
        throw new Error("not an instance");
    if (typeof n.detachInstance !== "function")
        throw new Error("detach unsupported on this node");
    return serializeNode(n.detachInstance(), 1, detailOf(params));
}
async function cmdSetLayoutConstraints(params) {
    if (!params?.nodeId)
        throw new Error("nodeId required");
    if (params.horizontal === undefined && params.vertical === undefined)
        throw new Error("horizontal or vertical required");
    const allowed = ["MIN", "CENTER", "MAX", "STRETCH", "SCALE"];
    if (params.horizontal !== undefined && !allowed.includes(params.horizontal))
        throw new Error("invalid horizontal: expected MIN|CENTER|MAX|STRETCH|SCALE");
    if (params.vertical !== undefined && !allowed.includes(params.vertical))
        throw new Error("invalid vertical: expected MIN|CENTER|MAX|STRETCH|SCALE");
    const n = await findNode(params.nodeId);
    if (!n || !("constraints" in n))
        throw new Error("node has no constraints");
    const g = n;
    g.constraints = { horizontal: params.horizontal ?? g.constraints.horizontal, vertical: params.vertical ?? g.constraints.vertical };
    return serializeNode(n, 0, detailOf(params));
}
async function cmdSetLayoutPositioning(params) {
    if (!params?.nodeId)
        throw new Error("nodeId required");
    if (params.positioning !== "AUTO" && params.positioning !== "ABSOLUTE")
        throw new Error("invalid positioning: expected AUTO|ABSOLUTE");
    const n = await findNode(params.nodeId);
    if (!n || !("layoutPositioning" in n))
        throw new Error("node has no layoutPositioning");
    n.layoutPositioning = params.positioning;
    return serializeNode(n, 0, detailOf(params));
}
async function cmdCreateBooleanOperation(params) {
    const ids = params?.nodeIds || [];
    if (ids.length > 100)
        throw new Error("nodeIds[] limit is 100");
    if (ids.length < 2)
        throw new Error("need >=2 nodes");
    const op = params?.op;
    if (op !== "UNION" && op !== "SUBTRACT" && op !== "INTERSECT" && op !== "EXCLUDE")
        throw new Error("invalid op: expected UNION|SUBTRACT|INTERSECT|EXCLUDE");
    const nodes = [];
    for (const id of ids) {
        const n = await findNode(id);
        if (n && n.type !== "PAGE" && n.type !== "DOCUMENT")
            nodes.push(n);
    }
    if (nodes.length < 2)
        throw new Error("need >=2 nodes");
    const parent = params?.parentId ? await resolveParent(params.parentId) : nodes[0].parent;
    const index = typeof params?.index === "number" ? params.index : undefined;
    let result;
    if (op === "UNION")
        result = figma.union(nodes, parent, index);
    else if (op === "SUBTRACT")
        result = figma.subtract(nodes, parent, index);
    else if (op === "INTERSECT")
        result = figma.intersect(nodes, parent, index);
    else
        result = figma.exclude(nodes, parent, index);
    return serializeNode(result, 1, detailOf(params));
}
async function cmdCreateVector(params) {
    const v = figma.createVector();
    const parent = await resolveParent(params?.parentId);
    if (params?.vectorNetwork !== undefined) {
        try {
            await v.setVectorNetworkAsync(params.vectorNetwork);
        }
        catch (e) {
            try {
                v.remove();
            }
            catch (_e) { }
            throw new Error("setVectorNetwork failed: " + String(e?.message || e));
        }
    }
    parent.appendChild(v);
    if (typeof params?.x === "number")
        v.x = params.x;
    if (typeof params?.y === "number")
        v.y = params.y;
    return serializeNode(v, 0, detailOf(params));
}
async function cmdCreateSection(params) {
    if (typeof figma.createSection !== "function")
        throw new Error("sections unsupported in this editor");
    const s = figma.createSection();
    figma.currentPage.appendChild(s);
    if (params?.name)
        s.name = params.name;
    if (typeof params?.width === "number" && typeof params?.height === "number" && "resize" in s) {
        try {
            s.resize(params.width, params.height);
        }
        catch (_e) { }
    }
    if (typeof params?.x === "number")
        s.x = params.x;
    if (typeof params?.y === "number")
        s.y = params.y;
    return serializeNode(s, 0, detailOf(params));
}
async function cmdCreateShape(params) {
    const kind = String(params?.kind || "").toUpperCase();
    if (kind !== "LINE" && kind !== "POLYGON" && kind !== "STAR")
        throw new Error("invalid kind: expected LINE|POLYGON|STAR");
    const maker = kind === "LINE" ? figma.createLine : kind === "POLYGON" ? figma.createPolygon : figma.createStar;
    if (typeof maker !== "function")
        throw new Error(kind.toLowerCase() + " creation unsupported");
    const s = maker.call(figma);
    const parent = await resolveParent(params?.parentId);
    parent.appendChild(s);
    const pc = Number(params?.pointCount ?? params?.count ?? params?.points);
    if ((kind === "POLYGON" || kind === "STAR") && isFinite(pc)) {
        try {
            s.pointCount = Math.max(3, Math.floor(pc));
        }
        catch (_e) { }
    }
    if (typeof params?.x === "number")
        s.x = params.x;
    if (typeof params?.y === "number")
        s.y = params.y;
    if (params?.name)
        s.name = params.name;
    return serializeNode(s, 0, detailOf(params));
}
async function cmdCreateSlice(params) {
    if (typeof figma.createSlice !== "function")
        throw new Error("slices unsupported in this editor");
    const s = figma.createSlice();
    const parent = await resolveParent(params?.parentId);
    parent.appendChild(s);
    if (typeof params?.width === "number" && typeof params?.height === "number" && "resize" in s) {
        try {
            s.resize(params.width, params.height);
        }
        catch (_e) { }
    }
    if (typeof params?.x === "number")
        s.x = params.x;
    if (typeof params?.y === "number")
        s.y = params.y;
    if (params?.name)
        s.name = params.name;
    return serializeNode(s, 0, detailOf(params));
}
async function cmdSetImageFill(params) {
    if (!params?.nodeId)
        throw new Error("nodeId required");
    if (!params?.imageHash)
        throw new Error("imageHash required");
    const scaleMode = params.scaleMode ?? "FILL";
    if (!["FILL", "FIT", "CROP", "TILE"].includes(scaleMode))
        throw new Error("invalid scaleMode: expected FILL|FIT|CROP|TILE");
    const n = await findNode(params.nodeId);
    if (!n || !("fills" in n))
        throw new Error("node has no fills");
    try {
        const img = figma.getImageByHash(params.imageHash);
        if (!img)
            throw new Error("unknown imageHash — export a node or upload image first");
    }
    catch (e) {
        if (e?.message === "unknown imageHash — export a node or upload image first")
            throw e;
        throw new Error("unknown imageHash — export a node or upload image first");
    }
    const paint = { type: "IMAGE", imageHash: params.imageHash, scaleMode };
    if (params.opacity !== undefined)
        paint.opacity = params.opacity;
    if (params.visible !== undefined)
        paint.visible = params.visible;
    n.fills = [paint];
    return serializeNode(n, 0, detailOf(params));
}
async function cmdToggleLayerMask(params) {
    if (!params?.nodeId)
        throw new Error("nodeId required");
    const n = await findNode(params.nodeId);
    if (!n)
        throw new Error("node not found");
    if (n.type === "PAGE" || n.type === "DOCUMENT")
        throw new Error("cannot mask PAGE/DOCUMENT");
    if (!("isMask" in n))
        throw new Error("node has no isMask");
    const g = n;
    g.isMask = params.enabled === undefined ? !g.isMask : !!params.enabled;
    if (params.maskType !== undefined) {
        if (params.maskType !== "ALPHA" && params.maskType !== "VECTOR" && params.maskType !== "LUMINANCE")
            throw new Error("invalid maskType: expected ALPHA|VECTOR|LUMINANCE");
        if ("maskType" in g) {
            try {
                g.maskType = params.maskType;
            }
            catch (_e) { }
        }
    }
    return { id: g.id, isMask: g.isMask, ...(("maskType" in g) ? { maskType: clean(g.maskType) } : {}) };
}
// design-system helpers (variables)
async function cmdCreateVariableCollection(params) {
    const col = figma.variables.createVariableCollection(params?.name || "Tokens");
    return { id: col.id, name: col.name, modes: col.modes };
}
async function cmdCreateVariable(params) {
    if (!params?.collectionId)
        throw new Error("collectionId required");
    const col = await figma.variables.getVariableCollectionByIdAsync(params.collectionId);
    if (!col)
        throw new Error("collection not found");
    const vt = String(params?.type || "COLOR").toUpperCase();
    if (!["BOOLEAN", "COLOR", "FLOAT", "STRING", "TIMING", "EASING"].includes(vt))
        throw new Error("invalid type: expected BOOLEAN|COLOR|FLOAT|STRING|TIMING|EASING");
    const v = figma.variables.createVariable(params?.name || "token", col, vt);
    const mode = col.modes[0]?.modeId;
    if (params?.value !== undefined && mode) {
        try {
            v.setValueForMode(mode, params.value);
        }
        catch (_e) { }
    }
    if (params?.scopes !== undefined) {
        if (!Array.isArray(params.scopes))
            throw new Error("invalid scopes: expected string[]");
        for (const s of params.scopes) {
            if (typeof s !== "string" || !s)
                throw new Error("invalid scopes: expected non-empty strings");
        }
        try {
            v.scopes = params.scopes;
            return { id: v.id, name: v.name, scopesApplied: true };
        }
        catch (_e) {
            return { id: v.id, name: v.name, scopesApplied: false };
        }
    }
    return { id: v.id, name: v.name };
}
async function cmdSetVariableCodeSyntax(params) {
    if (!params?.variableId)
        throw new Error("variableId required");
    if (!["WEB", "ANDROID", "iOS"].includes(params?.platform))
        throw new Error("invalid platform: expected WEB|ANDROID|iOS");
    const v = await figma.variables.getVariableByIdAsync(params.variableId);
    if (!v)
        throw new Error("variable not found");
    if (params?.remove === true) {
        v.removeVariableCodeSyntax(params.platform);
        return { removed: true, id: v.id };
    }
    if (typeof params?.value !== "string")
        throw new Error("value required");
    v.setVariableCodeSyntax(params.platform, params.value);
    return { id: v.id };
}
async function cmdBindVariableToProperty(params) {
    if (!params?.nodeId || !params?.field || !params?.variableId)
        throw new Error("nodeId|field|variableId required");
    const n = await findNode(params.nodeId);
    if (!n)
        throw new Error("node not found");
    const v = await figma.variables.getVariableByIdAsync(params.variableId);
    if (!v)
        throw new Error("variable not found");
    const f = String(params.field);
    try {
        if (f.toLowerCase().includes("fill")) {
            const pf = (n.fills && n.fills.length ? n.fills : [{ type: "SOLID", color: { r: 0.8, g: 0.8, b: 0.8 } }]).slice();
            pf[0] = figma.variables.setBoundVariableForPaint(pf[0], "color", v);
            n.fills = pf;
        }
        else
            n.setBoundVariable(f, v);
    }
    catch (e) {
        throw new Error("bind failed for '" + f + "': " + String(e?.message || e) + ". allowed: width|height|characters|itemSpacing|paddingLeft|paddingRight|paddingTop|paddingBottom|visible|cornerRadius|opacity|strokeWeight|fontSize|lineHeight|letterSpacing (+fill via fills[0].color)");
    }
    return { nodeId: n.id, field: f };
}
async function cmdSetVariableAlias(params) {
    if (!params?.variableId || !params?.modeId || !params?.aliasId)
        throw new Error("variableId|modeId|aliasId required");
    const v = await figma.variables.getVariableByIdAsync(params.variableId);
    if (!v)
        throw new Error("variable not found");
    const a = await figma.variables.getVariableByIdAsync(params.aliasId);
    if (!a)
        throw new Error("alias variable not found");
    v.setValueForMode(params.modeId, figma.variables.createVariableAlias(a));
    return { id: v.id };
}
async function cmdGetVariableModes(params) {
    if (!params?.collectionId)
        throw new Error("collectionId required");
    const c = await figma.variables.getVariableCollectionByIdAsync(params.collectionId);
    if (!c)
        throw new Error("collection not found");
    return { id: c.id, name: c.name, modes: c.modes };
}
async function cmdCreateVariableMode(params) {
    if (!params?.collectionId || !params?.name)
        throw new Error("collectionId|name required");
    const c = await figma.variables.getVariableCollectionByIdAsync(params.collectionId);
    if (!c)
        throw new Error("collection not found");
    try {
        const modeId = c.addMode(params.name);
        return { modeId, modes: c.modes };
    }
    catch (e) {
        throw new Error("addMode failed (extended collections unsupported): " + String(e?.message || e));
    }
}
async function cmdUpdateVariableMode(params) {
    if (!params?.collectionId || !params?.modeId)
        throw new Error("collectionId|modeId required");
    const c = await figma.variables.getVariableCollectionByIdAsync(params.collectionId);
    if (!c)
        throw new Error("collection not found");
    if ((params?.action || "rename") === "remove")
        c.removeMode(params.modeId);
    else {
        if (!params?.name)
            throw new Error("name required");
        c.renameMode(params.modeId, params.name);
    }
    return { modes: c.modes };
}
async function cmdBatchUpdateVariables(params) {
    const updates = params?.updates || [];
    if (!Array.isArray(updates))
        throw new Error("updates[] required");
    if (updates.length > 100)
        throw new Error("updates[] limit is 100");
    const results = [];
    for (const u of updates) {
        try {
            const v = await figma.variables.getVariableByIdAsync(u?.variableId);
            if (!v)
                throw new Error("variable not found: " + String(u?.variableId));
            const val = u?.aliasId ? figma.variables.createVariableAlias(await figma.variables.getVariableByIdAsync(u.aliasId)) : u?.value;
            if (val === undefined)
                throw new Error("value or aliasId required");
            v.setValueForMode(u.modeId, val);
            results.push({ ok: true, id: v.id });
        }
        catch (e) {
            results.push({ ok: false, id: u?.variableId, error: String(e?.message || e) });
        }
    }
    return { results };
}
async function cmdSetNodeVariableMode(params) {
    if (!params?.nodeId || !params?.collectionId || !params?.modeId)
        throw new Error("nodeId|collectionId|modeId required");
    const n = await findNode(params.nodeId);
    if (!n)
        throw new Error("node not found");
    const c = await figma.variables.getVariableCollectionByIdAsync(params.collectionId);
    if (!c)
        throw new Error("collection not found");
    n.setExplicitVariableModeForCollection(c, params.modeId);
    return { nodeId: n.id };
}
async function cmdGetDevResources(params) {
    const target = params?.nodeId ? await findNode(params.nodeId) : figma.currentPage;
    if (!target)
        throw new Error("node not found");
    if (typeof target.getDevResourcesAsync !== "function")
        throw new Error("dev resources unsupported");
    try {
        return await target.getDevResourcesAsync({ includeChildren: false });
    }
    catch (e) {
        throw new Error("getDevResources failed: " + String(e?.message || e));
    }
}
async function cmdAttachDevResource(params) {
    if (!params?.url)
        throw new Error("url required");
    const target = params?.nodeId ? await findNode(params.nodeId) : figma.currentPage;
    if (!target)
        throw new Error("node not found");
    if (typeof target.addDevResourceAsync !== "function")
        throw new Error("dev resources unsupported");
    try {
        await target.addDevResourceAsync(params.url, params.name);
    }
    catch (e) {
        throw new Error("addDevResource failed: " + String(e?.message || e));
    }
    return { ok: true, nodeId: target.id };
}
async function cmdInspectCss(params) {
    if (!params?.nodeId)
        throw new Error("nodeId required");
    const n = await findNode(params.nodeId);
    if (!n)
        throw new Error("node not found");
    if (typeof n.getCSSAsync !== "function")
        throw new Error("css unsupported");
    try {
        return await n.getCSSAsync();
    }
    catch (e) {
        throw new Error("getCSS failed: " + String(e?.message || e));
    }
}
async function cmdCreateVersionHistory(params) {
    const title = String(params?.title ?? "").trim().slice(0, 200);
    if (!title)
        throw new Error("title required");
    try {
        const r = await figma.saveVersionHistoryAsync(title, params.description);
        if (r && typeof r.id === "string")
            return { id: r.id };
        return { ok: true };
    }
    catch (e) {
        throw new Error("saveVersionHistory failed: " + String(e?.message || e));
    }
}
async function cmdAddPrototypeLink(params) {
    if (!params?.nodeId)
        throw new Error("nodeId required");
    if (!params?.destinationId)
        throw new Error("destinationId required");
    const n = await findNode(params.nodeId);
    if (!n)
        throw new Error("node not found");
    if (typeof n.setReactionsAsync !== "function")
        throw new Error("prototype links unsupported on this node");
    const dest = await findNode(params.destinationId);
    if (!dest)
        throw new Error("destination not found");
    const t = String(params.transition || "").toUpperCase();
    const transition = t === "DISSOLVE" || t === "SMART_ANIMATE" ? { type: t } : null;
    const existing = Array.isArray(n.reactions) ? [...n.reactions] : [];
    existing.push({ trigger: { type: "ON_CLICK" }, actions: [{ type: "NODE", destinationId: dest.id, navigation: "NAVIGATE", transition }] });
    try {
        await n.setReactionsAsync(existing);
    }
    catch (e) {
        throw new Error("setReactions failed: " + String(e?.message || e));
    }
    return { nodeId: n.id, destinationId: dest.id, reactions: existing.length };
}
async function cmdClearPrototypeLinks(params) {
    if (!params?.nodeId)
        throw new Error("nodeId required");
    const n = await findNode(params.nodeId);
    if (!n)
        throw new Error("node not found");
    if (typeof n.setReactionsAsync !== "function")
        throw new Error("prototype links unsupported on this node");
    try {
        await n.setReactionsAsync([]);
    }
    catch (e) {
        throw new Error("clearReactions failed: " + String(e?.message || e));
    }
    return { nodeId: n.id, cleared: true };
}
async function cmdGetReactions(params) {
    if (!params?.nodeId)
        throw new Error("nodeId required");
    const n = await findNode(params.nodeId);
    if (!n)
        throw new Error("node not found");
    if (!("reactions" in n))
        return [];
    try {
        return safeSerialize(n.reactions ?? []);
    }
    catch (e) {
        throw new Error("reactions unsupported: " + String(e?.message || e));
    }
}
async function cmdApplyStyle(params) {
    if (!params?.nodeId)
        throw new Error("nodeId required");
    if (!params?.styleId)
        throw new Error("styleId required");
    const kind = String(params.kind || "").toUpperCase();
    if (kind !== "PAINT" && kind !== "TEXT" && kind !== "EFFECT")
        throw new Error("invalid kind: expected PAINT|TEXT|EFFECT");
    const n = await findNode(params.nodeId);
    if (!n)
        throw new Error("node not found");
    const id = String(params.styleId);
    const prop = kind === "PAINT" ? "fillStyleId" : kind === "TEXT" ? "textStyleId" : "effectStyleId";
    const setter = kind === "PAINT" ? "setFillStyleIdAsync" : kind === "TEXT" ? "setTextStyleIdAsync" : "setEffectStyleIdAsync";
    const list = kind === "PAINT" ? await figma.getLocalPaintStylesAsync().catch(() => [])
        : kind === "TEXT" ? await figma.getLocalTextStylesAsync().catch(() => [])
            : await figma.getLocalEffectStylesAsync().catch(() => []);
    const hit = list.find((s) => s && s.id === id);
    if (!hit)
        throw new Error("style not found: " + id);
    if (kind === "TEXT") {
        if (n.type !== "TEXT")
            throw new Error("node is not text");
        try {
            const fn = hit.fontName;
            if (fn && typeof fn === "object" && typeof fn.family === "string")
                await figma.loadFontAsync({ family: fn.family, style: fn.style || "Regular" });
            else
                await ensureFont();
        }
        catch (e) {
            throw new Error("font load failed for text style: " + String(e?.message || e));
        }
    }
    if (typeof n[setter] !== "function" && !(prop in n))
        throw new Error(kind.toLowerCase() + " styles unsupported on this node");
    try {
        if (typeof n[setter] === "function")
            await n[setter](id);
        else
            n[prop] = id;
    }
    catch (e) {
        throw new Error("applyStyle failed: " + String(e?.message || e));
    }
    return serializeNode(n, 0, detailOf(params));
}
async function cmdSetExportSettings(params) {
    if (!params?.nodeId)
        throw new Error("nodeId required");
    if (!Array.isArray(params?.settings))
        throw new Error("settings[] required: expected array of ExportSettings");
    const n = await findNode(params.nodeId);
    if (!n)
        throw new Error("node not found");
    if (!("exportSettings" in n))
        throw new Error("node has no exportSettings");
    try {
        n.exportSettings = params.settings;
    }
    catch (e) {
        throw new Error("setExportSettings failed: " + String(e?.message || e));
    }
    return serializeNode(n, 0, detailOf(params));
}
async function cmdSetViewport(params) {
    const v = figma.viewport;
    if (params?.zoom !== undefined) {
        const z = Number(params.zoom);
        if (!isFinite(z) || z <= 0)
            throw new Error("invalid zoom: expected number > 0");
        try {
            v.zoom = z;
        }
        catch (e) {
            throw new Error("setViewport failed: " + String(e?.message || e));
        }
    }
    if (params?.centerX !== undefined || params?.centerY !== undefined) {
        const cx = params.centerX !== undefined ? Number(params.centerX) : v.center.x;
        const cy = params.centerY !== undefined ? Number(params.centerY) : v.center.y;
        if (!isFinite(cx) || !isFinite(cy))
            throw new Error("invalid center: expected finite numbers");
        try {
            v.center = { x: cx, y: cy };
        }
        catch (e) {
            throw new Error("setViewport failed: " + String(e?.message || e));
        }
    }
    return cmdGetCanvasView(params);
}
async function cmdUngroup(params) {
    if (!params?.nodeId)
        throw new Error("nodeId required");
    const n = await findNode(params.nodeId);
    if (!n)
        throw new Error("node not found");
    if (n.type !== "GROUP")
        throw new Error("node is not a group");
    if (typeof figma.ungroup !== "function")
        throw new Error("ungroup unsupported");
    const kids = figma.ungroup(n);
    return { id: n.id, children: kids.map((k) => ({ id: k.id, name: k.name, type: k.type })) };
}
async function cmdCreateSimple(fn, params) {
    const F = figma;
    if (typeof F[fn] !== "function")
        throw new Error(fn + " unsupported in this editor");
    let n;
    if (fn === "createTable") {
        const r = Math.max(1, Math.min(50, Math.floor(Number(params?.numRows ?? 2) || 2)));
        const c = Math.max(1, Math.min(50, Math.floor(Number(params?.numColumns ?? 2) || 2)));
        n = F.createTable(r, c);
    }
    else if (fn === "createSlide") {
        n = (params?.row !== undefined || params?.col !== undefined) ? F.createSlide(Number(params?.row ?? 0), Number(params?.col ?? 0)) : F.createSlide();
        try {
            figma.currentPage.appendChild(n);
        }
        catch (_e) { }
        return serializeNode(n, 1, detailOf(params));
    }
    else {
        n = F[fn]();
    }
    const parent = await resolveParent(params?.parentId);
    try {
        parent.appendChild(n);
    }
    catch (_e) {
        figma.currentPage.appendChild(n);
    }
    if (params?.name)
        n.name = params.name;
    if (typeof params?.x === "number")
        n.x = params.x;
    if (typeof params?.y === "number")
        n.y = params.y;
    return serializeNode(n, 1, detailOf(params));
}
async function cmdSetGuides(params) {
    if (!params?.nodeId)
        throw new Error("nodeId required");
    if (!Array.isArray(params?.guides))
        throw new Error("guides[] required");
    const n = await findNode(params.nodeId);
    if (!n || (n.type !== "PAGE" && n.type !== "FRAME") || !("guides" in n))
        throw new Error("node is not a page or frame");
    const g = params.guides.map((x) => {
        if (x?.axis !== "X" && x?.axis !== "Y")
            throw new Error("guide axis must be X|Y");
        if (typeof x?.offset !== "number")
            throw new Error("guide offset must be number");
        return { axis: x.axis, offset: x.offset };
    });
    try {
        n.guides = g;
    }
    catch (e) {
        throw new Error("set guides failed: " + String(e?.message || e));
    }
    return { id: n.id, guideCount: g.length };
}
async function cmdDeletePage(params) {
    if (params?.confirm !== true)
        throw new Error("confirm:true required");
    const id = params?.pageId || params?.nodeId || params?.id;
    if (!id)
        throw new Error("single pageId required");
    if (id === figma.currentPage.id)
        throw new Error("refuse to delete currentPage");
    const n = await findNode(id);
    if (!n || n.type !== "PAGE")
        throw new Error("page not found");
    n.remove();
    return { deleted: 1, id, undoHint: "Undo (Ctrl/Cmd+Z) restores the deleted page" };
}
async function cmdImportSvg(params) {
    const svg = String(params?.svg ?? params?.code ?? "");
    if (!svg.trim())
        throw new Error("svg required");
    if (svg.length > 500000)
        throw new Error("svg too large (500k cap)");
    let n;
    try {
        n = figma.createNodeFromSvg(svg);
    }
    catch (e) {
        throw new Error("createNodeFromSvg failed: " + String(e?.message || e));
    }
    const parent = await resolveParent(params?.parentId);
    try {
        parent.appendChild(n);
    }
    catch (_e) {
        figma.currentPage.appendChild(n);
    }
    if (params?.name)
        n.name = params.name;
    return serializeNode(n, 1, detailOf(params));
}
async function cmdSetTextFont(params) {
    if (!params?.nodeId || !(params.family || params.fontFamily))
        throw new Error("nodeId|family required");
    const n = await findNode(params.nodeId);
    if (!n || n.type !== "TEXT")
        throw new Error("node is not text");
    const f = { family: params.family || params.fontFamily, style: params.style || params.fontStyle || "Regular" };
    await figma.loadFontAsync(f);
    n.fontName = f;
    return { id: n.id };
}
async function cmdCreateComponentPropDef(params) {
    if (!params?.nodeId || !params?.name || !params?.type)
        throw new Error("nodeId|name|type required");
    const n = await findNode(params.nodeId);
    if (!n || typeof n.addComponentProperty !== "function")
        throw new Error("node cannot have component props");
    const t = String(params.type).toUpperCase();
    if (!["BOOLEAN", "TEXT", "INSTANCE_SWAP", "VARIANT", "SLOT"].includes(t))
        throw new Error("invalid type: expected BOOLEAN|TEXT|INSTANCE_SWAP|VARIANT|SLOT");
    const opts = {};
    if (params?.preferredValues !== undefined) {
        if (!Array.isArray(params.preferredValues))
            throw new Error("invalid preferredValues: expected array");
        opts.preferredValues = params.preferredValues;
    }
    if (params?.description !== undefined) {
        if (typeof params.description !== "string")
            throw new Error("invalid description: expected string");
        opts.description = params.description;
    }
    if (params?.slotSettings !== undefined) {
        if (!params.slotSettings || typeof params.slotSettings !== "object" || Array.isArray(params.slotSettings))
            throw new Error("invalid slotSettings: expected object");
        opts.slotSettings = params.slotSettings;
    }
    const def = params.defaultValue ?? (t === "BOOLEAN" ? false : "");
    return { id: n.id, propertyName: Object.keys(opts).length ? n.addComponentProperty(params.name, t, def, opts) : n.addComponentProperty(params.name, t, def) };
}
async function cmdDeleteComponentPropDef(params) {
    if (!params?.nodeId || !params?.propertyName)
        throw new Error("nodeId|propertyName required");
    const n = await findNode(params.nodeId);
    if (!n || typeof n.deleteComponentProperty !== "function")
        throw new Error("node cannot have component props");
    n.deleteComponentProperty(params.propertyName);
    return { ok: true, id: n.id };
}
async function cmdCombineAsVariants(params) {
    const ids = params?.nodeIds || [];
    if (ids.length < 2)
        throw new Error("need >=2 nodes");
    const nodes = [];
    for (const id of ids) {
        const n = await findNode(id);
        if (n && n.type === "COMPONENT")
            nodes.push(n);
    }
    if (nodes.length < 2)
        throw new Error("need >=2 components");
    return serializeNode(figma.combineAsVariants(nodes, params?.parentId ? await resolveParent(params.parentId) : nodes[0].parent), 1, detailOf(params));
}
async function cmdRenameVariable(params) {
    if (!params?.variableId || !params?.name)
        throw new Error("variableId|name required");
    const v = await figma.variables.getVariableByIdAsync(params.variableId);
    if (!v)
        throw new Error("variable not found");
    v.name = params.name;
    return { id: v.id, name: v.name };
}
async function cmdUnbindVariable(params) {
    if (!params?.nodeId || !params?.field)
        throw new Error("nodeId|field required");
    const n = await findNode(params.nodeId);
    if (!n)
        throw new Error("node not found");
    const f = String(params.field);
    try {
        if (f.toLowerCase().includes("fill")) {
            const pf = (n.fills || []).slice();
            if (!pf.length)
                throw new Error("no fills");
            pf[0] = figma.variables.setBoundVariableForPaint(pf[0], "color", null);
            n.fills = pf;
        }
        else
            n.setBoundVariable(f, null);
    }
    catch (e) {
        throw new Error("unbind failed: " + String(e?.message || e));
    }
    return { ok: true, nodeId: n.id, field: f };
}
async function cmdDeleteVariable(params) {
    if (params?.confirm !== true || !params?.variableId)
        throw new Error("confirm:true + single variableId required");
    const v = await figma.variables.getVariableByIdAsync(params.variableId);
    if (!v)
        throw new Error("variable not found");
    const nm = v.name;
    v.remove();
    return { deleted: 1, id: params.variableId, name: nm, undoHint: "Undo (Ctrl/Cmd+Z) restores the deleted variable" };
}
async function cmdGetVariableById(params) {
    if (!params?.variableId)
        throw new Error("variableId required");
    const v = await figma.variables.getVariableByIdAsync(params.variableId);
    if (!v)
        throw new Error("variable not found");
    return { id: v.id, name: v.name, resolvedType: v.resolvedType, collectionId: v.variableCollectionId, scopes: v.scopes };
}
async function cmdGetVariableCollectionById(params) {
    if (!params?.collectionId)
        throw new Error("collectionId required");
    const c = await figma.variables.getVariableCollectionByIdAsync(params.collectionId);
    if (!c)
        throw new Error("collection not found");
    return { id: c.id, name: c.name, modes: c.modes, variableIds: c.variableIds, defaultModeId: c.defaultModeId };
}
async function cmdExtendCollection(params) {
    if (!params?.name)
        throw new Error("name required");
    const hasKey = !!params?.collectionKey;
    const hasId = !!params?.collectionId;
    if (hasKey === hasId)
        throw new Error("exactly one of collectionKey|collectionId required");
    if (hasKey) {
        const col = await figma.variables.extendLibraryCollectionByKeyAsync(String(params.collectionKey), String(params.name));
        return { id: col.id, name: col.name };
    }
    const local = await figma.variables.getVariableCollectionByIdAsync(params.collectionId);
    if (!local)
        throw new Error("collection not found");
    const ext = local.extend(String(params.name));
    return { id: ext.id, name: ext.name };
}
async function cmdDeleteVariableCollection(params) {
    if (params?.confirm !== true)
        throw new Error("confirm:true required");
    if (!params?.collectionId)
        throw new Error("collectionId required");
    const c = await figma.variables.getVariableCollectionByIdAsync(params.collectionId);
    if (!c)
        throw new Error("collection not found");
    c.remove();
    return { deleted: 1, id: params.collectionId };
}
async function cmdListLibraryCollections() {
    const list = await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync();
    return (Array.isArray(list) ? list : []).slice(0, 100).map((c) => ({ name: c.name, key: c.key, libraryName: c.libraryName }));
}
async function cmdListLibraryVariables(params) {
    if (!params?.key)
        throw new Error("key required");
    const list = await figma.teamLibrary.getVariablesInLibraryCollectionAsync(String(params.key));
    return (Array.isArray(list) ? list : []).slice(0, 200).map((v) => ({ name: v.name, key: v.key, resolvedType: v.resolvedType }));
}
async function cmdSetVectorNetwork(params) {
    if (!params?.nodeId || params?.vectorNetwork === undefined)
        throw new Error("nodeId|vectorNetwork required");
    const n = await findNode(params.nodeId);
    if (!n || typeof n.setVectorNetworkAsync !== "function")
        throw new Error("node has no vectorNetwork");
    try {
        await n.setVectorNetworkAsync(params.vectorNetwork);
        return serializeNode(n, 0, detailOf(params));
    }
    catch (e) {
        throw new Error("setVectorNetwork failed: " + String(e?.message || e));
    }
}
async function cmdSetReactions(params) {
    if (!params?.nodeId || !Array.isArray(params?.reactions))
        throw new Error("nodeId|reactions[] required");
    const n = await findNode(params.nodeId);
    if (!n || typeof n.setReactionsAsync !== "function")
        throw new Error("reactions unsupported on this node");
    try {
        await n.setReactionsAsync(params.reactions);
        return { nodeId: n.id, reactions: params.reactions.length };
    }
    catch (e) {
        throw new Error("setReactions failed: " + String(e?.message || e));
    }
}
async function cmdSetFlowStartingPoint(params) {
    if (!params?.nodeId)
        throw new Error("nodeId required");
    const n = await findNode(params.nodeId);
    if (!n)
        throw new Error("node not found");
    try {
        figma.currentPage.flowStartingPoints = [{ nodeId: n.id, name: params.name || "Flow" }];
        return { nodeId: n.id };
    }
    catch (e) {
        throw new Error("setFlowStartingPoint failed: " + String(e?.message || e));
    }
}
async function cmdEditDevResource(params) {
    if (!params?.currentUrl || (params?.url === undefined && params?.name === undefined))
        throw new Error("currentUrl + url|name required");
    const t = params?.nodeId ? await findNode(params.nodeId) : figma.currentPage;
    if (!t || typeof t.editDevResourceAsync !== "function")
        throw new Error("dev resources unsupported");
    try {
        await t.editDevResourceAsync(params.currentUrl, { url: params.url, name: params.name });
        return { ok: true, nodeId: t.id };
    }
    catch (e) {
        throw new Error("editDevResource failed: " + String(e?.message || e));
    }
}
async function cmdDeleteDevResource(params) {
    if (!params?.url)
        throw new Error("url required");
    const t = params?.nodeId ? await findNode(params.nodeId) : figma.currentPage;
    if (!t || typeof t.deleteDevResourceAsync !== "function")
        throw new Error("dev resources unsupported");
    try {
        await t.deleteDevResourceAsync(params.url);
        return { ok: true, nodeId: t.id };
    }
    catch (e) {
        throw new Error("deleteDevResource failed: " + String(e?.message || e));
    }
}
async function cmdImportVariable(params) {
    if (!params?.key)
        throw new Error("key required");
    let v;
    try {
        v = await figma.variables.importVariableByKeyAsync(String(params.key));
    }
    catch (e) {
        throw new Error("import variable failed: " + (e instanceof Error ? e.message : String(e)));
    }
    return { id: v.id, name: v.name };
}
async function cmdImportComponent(params) {
    if (!params?.key)
        throw new Error("key required");
    try {
        if (params.set) {
            const s = await figma.importComponentSetByKeyAsync(String(params.key));
            return { id: s.id, name: s.name, set: true };
        }
        const c = await figma.importComponentByKeyAsync(String(params.key));
        return { id: c.id, name: c.name, set: false };
    }
    catch (e) {
        throw new Error("import component failed: " + (e instanceof Error ? e.message : String(e)));
    }
}
async function cmdGetMainComponent(params) {
    if (!params?.nodeId)
        throw new Error("nodeId required");
    const n = await findNode(params.nodeId);
    if (!n || n.type !== "INSTANCE")
        throw new Error("node is not an instance");
    let main = null;
    try {
        main = await n.getMainComponentAsync();
    }
    catch (e) {
        throw new Error("getMainComponent failed: " + (e instanceof Error ? e.message : String(e)));
    }
    if (!main)
        return { id: n.id, mainComponent: null };
    return { id: n.id, mainComponent: { id: main.id, name: main.name } };
}
async function cmdResetInstance(params) {
    if (!params?.nodeId)
        throw new Error("nodeId required");
    const n = await findNode(params.nodeId);
    if (!n || n.type !== "INSTANCE")
        throw new Error("node is not an instance");
    if (typeof n.resetOverrides !== "function")
        throw new Error("resetOverrides unsupported on this node");
    try {
        n.resetOverrides();
    }
    catch (e) {
        throw new Error("resetOverrides failed: " + (e instanceof Error ? e.message : String(e)));
    }
    return { id: n.id, reset: true };
}
async function cmdTransformGroup(params) {
    if (!Array.isArray(params?.nodeIds) || params.nodeIds.length < 2)
        throw new Error("nodeIds[] required (2+)");
    const nodes = [];
    for (const id of params.nodeIds) {
        const n = await findNode(id);
        if (!n)
            throw new Error("node not found: " + id);
        if (n.type === "PAGE" || n.type === "DOCUMENT")
            throw new Error("refuse to transform PAGE/DOCUMENT");
        nodes.push(n);
    }
    const parent = params?.parentId ? await resolveParent(params.parentId) : (nodes[0].parent ?? figma.currentPage);
    const index = typeof params?.index === "number" ? params.index : parent.children.length;
    const modifiers = params?.modifiers ?? [];
    if (!Array.isArray(modifiers))
        throw new Error("invalid modifiers: expected array");
    try {
        return { id: figma.transformGroup(nodes, parent, index, modifiers).id };
    }
    catch (e) {
        throw new Error("transformGroup failed: " + (e instanceof Error ? e.message : String(e)));
    }
}
async function cmdGetMeasurements(params) {
    const page = figma.currentPage;
    if (typeof page.getMeasurements !== "function" || (params?.nodeId && typeof page.getMeasurementsForNode !== "function"))
        throw new Error("measurements unsupported in this build");
    const n = params?.nodeId ? await findNode(params.nodeId) : null;
    if (params?.nodeId && !n)
        throw new Error("node not found: " + params.nodeId);
    const list = n ? page.getMeasurementsForNode(n) : page.getMeasurements();
    return { measurements: safeSerialize((Array.isArray(list) ? list : []).slice(0, 200)) };
}
async function cmdGetStyleConsumers(params) {
    if (!params?.styleId)
        throw new Error("styleId required");
    const hit = await findStyleById(params.styleId);
    if (!hit)
        throw new Error("style not found: " + params.styleId);
    if (typeof hit.getStyleConsumersAsync !== "function")
        throw new Error("style consumers unsupported in this build");
    const list = await hit.getStyleConsumersAsync();
    return (Array.isArray(list) ? list.slice(0, 100) : []).map((c) => ({ nodeId: c?.node?.id, field: Array.isArray(c?.fields) ? c.fields[0] : c?.fields }));
}
async function cmdGetComponentInstances(params) {
    if (!params?.nodeId)
        throw new Error("nodeId required");
    const n = await findNode(params.nodeId);
    if (!n || n.type !== "COMPONENT")
        throw new Error("node is not a component");
    if (typeof n.getInstancesAsync !== "function")
        throw new Error("getInstancesAsync unsupported in this build");
    const list = await n.getInstancesAsync();
    return (Array.isArray(list) ? list.slice(0, 100) : []).map((i) => ({ id: i.id, name: i.name }));
}
async function cmdCreateSlot(params) {
    if (!params?.nodeId)
        throw new Error("nodeId required");
    const n = await findNode(params.nodeId);
    if (!n || n.type !== "COMPONENT")
        throw new Error("node is not a component");
    if (typeof n.createSlot !== "function")
        throw new Error("createSlot unsupported in this build");
    return { id: n.createSlot().id };
}
async function cmdResetSlot(params) {
    if (!params?.nodeId)
        throw new Error("nodeId required");
    const n = await findNode(params.nodeId);
    if (!n || n.type !== "SLOT")
        throw new Error("node is not a slot");
    if (typeof n.resetSlot !== "function")
        throw new Error("resetSlot unsupported in this build");
    n.resetSlot();
    return { id: n.id, reset: true };
}
async function cmdGetFontAxes(params) {
    if (!params?.family)
        throw new Error("family required");
    if (typeof figma.getFontFamilyVariationAxes !== "function")
        throw new Error("font axes unsupported in this build");
    return { family: params.family, axes: figma.getFontFamilyVariationAxes(params.family) };
}
async function cmdSetGridStyle(params) {
    if (!params?.nodeId || !params?.styleId)
        throw new Error("nodeId|styleId required");
    const n = await findNode(params.nodeId);
    if (!n || !("layoutGrids" in n))
        throw new Error("node has no layout grids");
    if (typeof n.setGridStyleIdAsync !== "function")
        throw new Error("grid styles unsupported in this build");
    await n.setGridStyleIdAsync(params.styleId);
    return { id: n.id, styleId: params.styleId };
}
async function cmdCreatePageDivider(params) {
    if (typeof figma.createPageDivider !== "function")
        throw new Error("page dividers unsupported in this build");
    const d = figma.createPageDivider(params?.name);
    return { id: d.id, name: d.name };
}
async function cmdGetFileThumbnail(_params) {
    if (typeof figma.getFileThumbnailNodeAsync !== "function")
        throw new Error("file thumbnail unsupported in this build");
    const t = await figma.getFileThumbnailNodeAsync();
    return { nodeId: t ? t.id : null };
}
async function cmdSetFileThumbnail(params) {
    if (!params?.nodeId)
        throw new Error("nodeId required");
    const n = await findNode(params.nodeId);
    if (!n || ["FRAME", "COMPONENT", "COMPONENT_SET", "SECTION"].indexOf(n.type) < 0)
        throw new Error("thumbnail node must be FRAME|COMPONENT|COMPONENT_SET|SECTION");
    if (typeof figma.setFileThumbnailNodeAsync !== "function")
        throw new Error("file thumbnail unsupported in this build");
    await figma.setFileThumbnailNodeAsync(n);
    return { nodeId: n.id, set: true };
}
async function cmdOpenUrl(params) {
    const url = String(params?.url ?? "");
    if (url.indexOf("http://") !== 0 && url.indexOf("https://") !== 0)
        throw new Error("invalid url: must start with http:// or https://");
    figma.openExternal(url);
    return { opened: true };
}
async function cmdEditComponentPropDef(params) {
    if (!params?.nodeId || !params?.propertyName)
        throw new Error("nodeId|propertyName required");
    for (const k of Object.keys(params || {})) {
        if (!["nodeId", "propertyName", "name", "defaultValue", "preferredValues", "description", "slotSettings"].includes(k))
            throw new Error("unsupported param: " + k + " (supported: name|defaultValue|preferredValues|description|slotSettings)");
    }
    const newValue = {};
    if (params.name !== undefined)
        newValue.name = params.name;
    if (params.defaultValue !== undefined)
        newValue.defaultValue = params.defaultValue;
    if (params.preferredValues !== undefined)
        newValue.preferredValues = params.preferredValues;
    if (params.description !== undefined)
        newValue.description = params.description;
    if (params.slotSettings !== undefined)
        newValue.slotSettings = params.slotSettings;
    if (!Object.keys(newValue).length)
        throw new Error("nothing to edit: provide name|defaultValue|preferredValues|description|slotSettings");
    const n = await findNode(params.nodeId);
    if (!n || typeof n.editComponentProperty !== "function")
        throw new Error("node cannot have component props");
    try {
        return { id: n.id, propertyName: n.editComponentProperty(params.propertyName, newValue) };
    }
    catch (e) {
        throw new Error("editComponentProperty failed: " + (e instanceof Error ? e.message : String(e)));
    }
}
async function cmdImportImage(params) {
    if (!params?.base64)
        throw new Error("base64 required");
    const raw = String(params.base64);
    if (raw.length > 5 * 1024 * 1024)
        throw new Error("base64 too large (5MB cap)");
    const stripped = raw.replace(/^data:[^,]*,/, "");
    let bytes;
    try {
        bytes = figma.base64Decode(stripped);
    }
    catch (e) {
        throw new Error("base64Decode failed: " + (e instanceof Error ? e.message : String(e)));
    }
    try {
        return { hash: figma.createImage(bytes).hash };
    }
    catch (e) {
        throw new Error("createImage failed: " + (e instanceof Error ? e.message : String(e)));
    }
}
async function cmdGetImageBytes(params) {
    if (!params?.hash)
        throw new Error("hash required");
    let img = null;
    try {
        img = figma.getImageByHash(params.hash);
    }
    catch (_e) {
        img = null;
    }
    if (!img)
        throw new Error("unknown imageHash — export a node or upload image first");
    let b64;
    try {
        b64 = figma.base64Encode(await img.getBytesAsync());
    }
    catch (e) {
        throw new Error("getBytes failed: " + (e instanceof Error ? e.message : String(e)));
    }
    let dims = {};
    try {
        const s = await img.getSizeAsync();
        dims = { width: s.width, height: s.height };
    }
    catch (_e) { }
    if (b64.length > 1500000)
        return { hash: params.hash, base64: b64.slice(0, 1500000), truncated: true, ...dims };
    return { hash: params.hash, base64: b64, ...dims };
}
async function cmdNotify(params) {
    if (params?.text === undefined || params?.text === null)
        throw new Error("text required");
    const text = String(params.text).slice(0, 300);
    if (!text)
        throw new Error("text required");
    const t = params?.timeout;
    try {
        if (typeof t === "number" && t >= 500 && t <= 10000)
            figma.notify(text, { timeout: t, ...(params?.error === true ? { error: true } : {}) });
        else if (params?.error === true)
            figma.notify(text, { error: true });
        else
            figma.notify(text);
    }
    catch (_e) {
        figma.notify(text);
    }
    return { notified: true };
}
async function cmdUndo() {
    try {
        figma.triggerUndo();
    }
    catch (e) {
        throw new Error("undo failed: " + (e instanceof Error ? e.message : String(e)));
    }
    return { undone: true };
}
async function cmdClientStorage(params) {
    const action = String(params?.action || "").toLowerCase();
    const key = params?.key;
    if (typeof key !== "string" || !key)
        throw new Error("key required");
    if (action === "get") {
        const value = await figma.clientStorage.getAsync(key);
        return { key, value: value === undefined ? null : value };
    }
    if (action === "set") {
        const v = params?.value;
        if (v === undefined || typeof v === "function" || typeof v === "symbol")
            throw new Error("value must be JSON-serializable");
        try {
            JSON.stringify(v);
        }
        catch (_e) {
            throw new Error("value must be JSON-serializable");
        }
        await figma.clientStorage.setAsync(key, v);
        return { key, saved: true };
    }
    throw new Error("invalid action: expected get|set");
}
async function cmdNodeData(params) {
    if (!params?.nodeId)
        throw new Error("nodeId required");
    const n = await findNode(params.nodeId);
    if (!n)
        throw new Error(`node not found: ${params.nodeId}`);
    const action = String(params?.action || "").toLowerCase();
    const key = params?.key;
    if (typeof key !== "string" || !key)
        throw new Error("key required");
    const shared = params?.shared === true;
    const ns = params?.namespace;
    if (shared && (typeof ns !== "string" || !ns))
        throw new Error("namespace required when shared:true");
    if (action === "get") {
        const value = shared ? n.getSharedPluginData(ns, key) : n.getPluginData(key);
        return { nodeId: params.nodeId, key, value };
    }
    if (action === "set") {
        const value = String(params?.value ?? "");
        if (shared)
            n.setSharedPluginData(ns, key, value);
        else
            n.setPluginData(key, value);
        return { nodeId: params.nodeId, key, saved: true };
    }
    throw new Error("invalid action: expected get|set");
}
let docWatch = false;
function onDocumentChange(ev) {
    if (!docWatch)
        return;
    try {
        const changes = (ev && ev.documentChanges) || [];
        const kinds = [];
        for (const c of changes) {
            const k = String((c && c.type) || "unknown");
            if (kinds.indexOf(k) < 0)
                kinds.push(k);
            if (kinds.length >= 10)
                break;
        }
        figma.ui.postMessage({ type: "event", event: "documentchange", data: { changes: changes.length, kinds } });
    }
    catch (_e) { }
}
async function cmdWatchDocument(params) {
    const on = params?.on === true;
    if (on && !docWatch) {
        docWatch = true;
        try {
            figma.on("documentchange", onDocumentChange);
        }
        catch (_e) { }
    }
    else if (!on && docWatch) {
        try {
            figma.off("documentchange", onDocumentChange);
        }
        catch (_e) { }
        docWatch = false;
    }
    return { watching: docWatch };
}
// MOTION COMPAT (Beta) - ALL Motion API access routes through here; on rename, update this table only
function motionNodeCall(node, names, args, what) {
    for (const name of names) {
        const fn = node?.[name];
        if (typeof fn === "function")
            return fn.apply(node, args);
    }
    throw new Error(`Motion API changed: none of [${names.join(", ")}] for ${what}`);
}
function motionRoot() {
    const m = figma?.motion;
    if (!m)
        throw new Error("Motion API unavailable: figma.motion missing");
    return m;
}
async function cmdGetMotionInfo() {
    const m = motionRoot();
    let playhead = null;
    try {
        playhead = m.playheadPosition ?? null;
    }
    catch (_e) {
        playhead = null;
    }
    let styles = [];
    try {
        const list = motionNodeCall(m, ["figmaAnimationStyles"], [], "figmaAnimationStyles");
        if (Array.isArray(list))
            styles = list.slice(0, 100).map((s) => ({ styleId: s.styleId, name: s.name, ...(s.description !== undefined ? { description: s.description } : {}) }));
    }
    catch (_e) {
        styles = [];
    }
    return { playhead, styles };
}
async function cmdGetNodeAnimations(params) {
    if (!params?.nodeId)
        throw new Error("nodeId required");
    const n = await findNode(params.nodeId);
    if (!n)
        throw new Error(`node not found: ${params.nodeId}`);
    const out = {};
    for (const k of ["animations", "manualKeyframeTracks", "timelines", "animationStyles"]) {
        try {
            const s = safeSerialize(n[k]);
            out[k] = Array.isArray(s) && s.length > 50 ? { items: s.slice(0, 50), truncated: true } : s;
        }
        catch (_e) {
            out[k] = null;
        }
    }
    return out;
}
async function cmdApplyMotionStyle(params) {
    if (!params?.nodeId)
        throw new Error("nodeId required");
    if (!params?.styleId)
        throw new Error("styleId required");
    const n = await findNode(params.nodeId);
    if (!n)
        throw new Error(`node not found: ${params.nodeId}`);
    let config = undefined;
    if (params.config !== undefined) {
        if (!params.config || typeof params.config !== "object")
            throw new Error("invalid config: expected object");
        config = {};
        if (params.config.duration !== undefined) {
            if (typeof params.config.duration !== "number" || !(params.config.duration >= 0))
                throw new Error("invalid config.duration: expected number>=0");
            config.duration = params.config.duration;
        }
        if (params.config.timelineOffset !== undefined) {
            if (typeof params.config.timelineOffset !== "number")
                throw new Error("invalid config.timelineOffset: expected number");
            config.timelineOffset = params.config.timelineOffset;
        }
        if (params.config.props !== undefined) {
            if (!params.config.props || typeof params.config.props !== "object")
                throw new Error("invalid config.props: expected object");
            config.props = params.config.props;
        }
    }
    const id = config === undefined
        ? motionNodeCall(n, ["applyAnimationStyle"], [params.styleId], "applyAnimationStyle")
        : motionNodeCall(n, ["applyAnimationStyle"], [params.styleId, config], "applyAnimationStyle");
    return { id, nodeId: n.id };
}
async function cmdRemoveMotionStyle(params) {
    if (!params?.nodeId)
        throw new Error("nodeId required");
    if (!params?.id)
        throw new Error("id required");
    const n = await findNode(params.nodeId);
    if (!n)
        throw new Error(`node not found: ${params.nodeId}`);
    motionNodeCall(n, ["removeAnimationStyle"], [params.id], "removeAnimationStyle");
    return { removed: true };
}
const MOTION_FIELD_ALIASES = { x: "TRANSLATION_X", y: "TRANSLATION_Y", xy: "TRANSLATION_XY", opacity: "OPACITY", scale: "SCALE_XY", scalex: "SCALE_X", scaley: "SCALE_Y", rotation: "ROTATION", width: "WIDTH", height: "HEIGHT", cornerradius: "CORNER_RADIUS", strokeweight: "STROKE_WEIGHT" };
function motionField(f) {
    if (f && typeof f === "object")
        return f;
    if (typeof f !== "string" || !f)
        throw new Error("field required");
    const hit = MOTION_FIELD_ALIASES[f.toLowerCase()];
    if (hit)
        return { type: "PROPERTY", name: hit };
    return { type: "PROPERTY", name: f };
}
function motionKeyframeValue(v) {
    if (typeof v === "number")
        return { type: "FLOAT", value: v };
    if (typeof v === "string") {
        const rgb = hexToRgb(v);
        if (rgb)
            return { type: "COLOR", value: { r: rgb.r, g: rgb.g, b: rgb.b, a: 1 } };
        return { type: "TEXT_DATA", value: v };
    }
    if (typeof v === "boolean")
        return { type: "BOOL", value: v };
    if (v && typeof v === "object") {
        if (typeof v.type === "string")
            return v;
        if (typeof v.r === "number" && typeof v.g === "number" && typeof v.b === "number") {
            const rgb = toRgb(v);
            return { type: "COLOR", value: { r: rgb.r, g: rgb.g, b: rgb.b, a: 1 } };
        }
    }
    throw new Error("invalid keyframe value: expected number|hex|{r,g,b}|string|boolean|{type,...}");
}
const MOTION_EASING_TYPES = ["EASE_IN", "EASE_OUT", "EASE_IN_AND_OUT", "LINEAR", "EASE_IN_BACK", "EASE_OUT_BACK", "EASE_IN_AND_OUT_BACK", "CUSTOM_CUBIC_BEZIER", "GENTLE", "QUICK", "BOUNCY", "SLOW", "CUSTOM_SPRING", "HOLD"];
function motionEasing(e) {
    if (typeof e === "string") {
        const t = e.toUpperCase();
        if (!MOTION_EASING_TYPES.includes(t))
            throw new Error("invalid easing: expected " + MOTION_EASING_TYPES.join("|") + "|{spring}|{bezier}");
        return { type: t };
    }
    if (e && typeof e === "object") {
        if (e.spring !== undefined) {
            const s = e.spring;
            if (!s || typeof s.mass !== "number" || typeof s.stiffness !== "number" || typeof s.damping !== "number")
                throw new Error("invalid spring: expected {mass,stiffness,damping} numbers");
            const bounce = motionNodeCall(motionRoot(), ["physicalSpringToNormalized"], [{ mass: s.mass, stiffness: s.stiffness, damping: s.damping }], "physicalSpringToNormalized");
            return { type: "CUSTOM_SPRING", easingFunctionSpring: { bounce } };
        }
        if (e.bezier !== undefined) {
            const b = e.bezier;
            if (!b || typeof b.x1 !== "number" || typeof b.y1 !== "number" || typeof b.x2 !== "number" || typeof b.y2 !== "number")
                throw new Error("invalid bezier: expected {x1,y1,x2,y2} numbers");
            return { type: "CUSTOM_CUBIC_BEZIER", easingFunctionCubicBezier: { x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2 } };
        }
    }
    throw new Error("invalid easing: expected " + MOTION_EASING_TYPES.join("|") + "|{spring}|{bezier}");
}
async function cmdSetManualKeyframes(params) {
    if (!params?.nodeId)
        throw new Error("nodeId required");
    if (params?.field === undefined)
        throw new Error("field required");
    if (!Array.isArray(params?.keyframes) || !params.keyframes.length)
        throw new Error("keyframes[] required (non-empty)");
    const n = await findNode(params.nodeId);
    if (!n)
        throw new Error(`node not found: ${params.nodeId}`);
    const field = motionField(params.field);
    const op = params.operation ?? "SET";
    if (op !== "SET" && op !== "OFFSET" && op !== "SCALE")
        throw new Error("invalid operation: expected SET|OFFSET|SCALE");
    const keyframes = params.keyframes.map((k) => {
        const t = Number(k?.t ?? k?.timelinePosition);
        if (!Number.isFinite(t) || t < 0)
            throw new Error("invalid keyframe t: expected number>=0");
        if (k?.value === undefined)
            throw new Error("invalid keyframe value: value required");
        const out = { timelinePosition: t, value: motionKeyframeValue(k.value) };
        if (k?.easing !== undefined)
            out.easing = motionEasing(k.easing);
        return out;
    });
    const track = { keyframes, keyframeOperation: op };
    if (params.baseValue !== undefined)
        track.baseValue = motionKeyframeValue(params.baseValue);
    motionNodeCall(n, ["applyManualKeyframeTrack"], [field, track], "applyManualKeyframeTrack");
    return { nodeId: n.id, field, keyframes: keyframes.length };
}
async function cmdRemoveManualKeyframes(params) {
    if (!params?.nodeId)
        throw new Error("nodeId required");
    if (params?.field === undefined)
        throw new Error("field required");
    const n = await findNode(params.nodeId);
    if (!n)
        throw new Error(`node not found: ${params.nodeId}`);
    motionNodeCall(n, ["removeManualKeyframeTrack"], [motionField(params.field)], "removeManualKeyframeTrack");
    return { removed: true };
}
async function cmdSetTimelineDuration(params) {
    if (!params?.nodeId)
        throw new Error("nodeId required");
    if (!params?.id)
        throw new Error("id required");
    const duration = Number(params?.duration);
    if (!Number.isFinite(duration) || !(duration > 0))
        throw new Error("invalid duration: expected number>0");
    const n = await findNode(params.nodeId);
    if (!n)
        throw new Error(`node not found: ${params.nodeId}`);
    motionNodeCall(n, ["setTimelineDuration"], [params.id, duration], "setTimelineDuration");
    return { nodeId: n.id, id: params.id, duration };
}
// ---------- router ----------
async function handleCommand(command, params) {
    switch (command) {
        case "ping": return { pong: true, file: figma.root.name };
        case "get_document_info": return cmdGetDocumentInfo();
        case "get_current_page":
            await figma.currentPage.loadAsync().catch(() => { });
            return serializeNode(figma.currentPage, 2, detailOf(params));
        case "get_selection": return cmdGetSelection(params);
        case "get_node_tree": return cmdGetNodeTree(params);
        case "get_node_by_id": return cmdGetNodeById(params);
        case "get_local_components": return cmdGetLocalComponents();
        case "get_local_styles": return cmdGetLocalStyles();
        case "apply_style": return cmdApplyStyle(params);
        case "get_local_variables": return cmdGetLocalVariables();
        case "export_node": return cmdExportNode(params);
        case "set_export_settings": return cmdSetExportSettings(params);
        case "create_frame": return cmdCreateFrame(params);
        case "create_rectangle": return cmdCreateRectangle(params);
        case "create_ellipse": return cmdCreateEllipse(params);
        case "create_text": return cmdCreateText(params);
        case "set_text_content": return cmdSetTextContent(params);
        case "set_text_props": return cmdSetTextProps(params);
        case "set_fills": return cmdSetFills(params);
        case "set_strokes": return cmdSetStrokes(params);
        case "set_effects": return cmdSetEffects(params);
        case "set_blend_mode": return cmdSetBlendMode(params);
        case "create_style": return cmdCreateStyle(params);
        case "delete_style": return cmdDeleteStyle(params);
        case "rename_style": return cmdRenameStyle(params);
        case "set_page_backgrounds": return cmdSetPageBackgrounds(params);
        case "set_node_props": return cmdSetNodeProps(params);
        case "set_layout": return cmdSetLayout(params);
        case "set_layout_child": return cmdSetLayoutChild(params);
        case "delete_nodes": return cmdDeleteNodes(params);
        case "clone_node": return cmdCloneNode(params);
        case "move_node": return cmdMoveNode(params);
        case "set_selection": return cmdSetSelection(params);
        case "scroll_to_node": return cmdScrollToNode(params);
        case "add_to_selection": return cmdAddToSelection(params);
        case "clear_selection": return cmdClearSelection(params);
        case "get_canvas_view": return cmdGetCanvasView(params);
        case "set_viewport": return cmdSetViewport(params);
        case "create_page": return cmdCreatePage(params);
        case "page_ops": return cmdPageOps(params);
        case "group_nodes": return cmdGroupNodes(params);
        case "create_component": return cmdCreateComponent(params);
        case "create_instance": return cmdCreateInstance(params);
        case "import_component": return cmdImportComponent(params);
        case "set_instance_props": return cmdSetInstanceProps(params);
        case "swap_instance": return cmdSwapInstance(params);
        case "detach_instance": return cmdDetachInstance(params);
        case "get_main_component": return cmdGetMainComponent(params);
        case "reset_instance": return cmdResetInstance(params);
        case "set_layout_constraints": return cmdSetLayoutConstraints(params);
        case "set_layout_positioning": return cmdSetLayoutPositioning(params);
        case "create_boolean_operation": return cmdCreateBooleanOperation(params);
        case "create_vector": return cmdCreateVector(params);
        case "create_section": return cmdCreateSection(params);
        case "create_shape": return cmdCreateShape(params);
        case "create_slice": return cmdCreateSlice(params);
        case "set_image_fill": return cmdSetImageFill(params);
        case "import_image": return cmdImportImage(params);
        case "get_image_bytes": return cmdGetImageBytes(params);
        case "toggle_layer_mask": return cmdToggleLayerMask(params);
        case "create_variable_collection": return cmdCreateVariableCollection(params);
        case "create_variable": return cmdCreateVariable(params);
        case "import_variable": return cmdImportVariable(params);
        case "set_variable_code_syntax": return cmdSetVariableCodeSyntax(params);
        case "bind_variable_to_property": return cmdBindVariableToProperty(params);
        case "set_variable_alias": return cmdSetVariableAlias(params);
        case "get_variable_modes": return cmdGetVariableModes(params);
        case "create_variable_mode": return cmdCreateVariableMode(params);
        case "update_variable_mode": return cmdUpdateVariableMode(params);
        case "batch_update_variables": return cmdBatchUpdateVariables(params);
        case "set_node_variable_mode": return cmdSetNodeVariableMode(params);
        case "get_dev_resources": return cmdGetDevResources(params);
        case "attach_dev_resource": return cmdAttachDevResource(params);
        case "inspect_css": return cmdInspectCss(params);
        case "create_version_history": return cmdCreateVersionHistory(params);
        case "add_prototype_link": return cmdAddPrototypeLink(params);
        case "clear_prototype_links": return cmdClearPrototypeLinks(params);
        case "get_reactions": return cmdGetReactions(params);
        case "ungroup": return cmdUngroup(params);
        case "move_node_index": return cmdMoveNode(params);
        case "create_table": return cmdCreateSimple("createTable", params);
        case "create_connector": return cmdCreateSimple("createConnector", params);
        case "set_guides": return cmdSetGuides(params);
        case "delete_page": return cmdDeletePage(params);
        case "create_sticky": return cmdCreateSimple("createSticky", params);
        case "create_shape_with_text": return cmdCreateSimple("createShapeWithText", params);
        case "create_code_block": return cmdCreateSimple("createCodeBlock", params);
        case "create_slide": return cmdCreateSimple("createSlide", params);
        case "import_svg": return cmdImportSvg(params);
        case "set_text_font": return cmdSetTextFont(params);
        case "create_component_prop_def": return cmdCreateComponentPropDef(params);
        case "delete_component_prop_def": return cmdDeleteComponentPropDef(params);
        case "edit_component_prop_def": return cmdEditComponentPropDef(params);
        case "combine_as_variants": return cmdCombineAsVariants(params);
        case "rename_variable": return cmdRenameVariable(params);
        case "unbind_variable": return cmdUnbindVariable(params);
        case "delete_variable": return cmdDeleteVariable(params);
        case "get_variable_by_id": return cmdGetVariableById(params);
        case "get_variable_collection_by_id": return cmdGetVariableCollectionById(params);
        case "extend_collection": return cmdExtendCollection(params);
        case "delete_variable_collection": return cmdDeleteVariableCollection(params);
        case "list_library_collections": return cmdListLibraryCollections();
        case "list_library_variables": return cmdListLibraryVariables(params);
        case "set_vector_network": return cmdSetVectorNetwork(params);
        case "set_reactions": return cmdSetReactions(params);
        case "set_flow_starting_point": return cmdSetFlowStartingPoint(params);
        case "edit_dev_resource": return cmdEditDevResource(params);
        case "delete_dev_resource": return cmdDeleteDevResource(params);
        case "set_text_range": return cmdSetTextRange(params);
        case "edit_text_chars": return cmdEditTextChars(params);
        case "list_fonts": return cmdListFonts();
        case "get_text_segments": return cmdGetTextSegments(params);
        case "get_text_list": return cmdGetTextList(params);
        case "set_text_list": return cmdSetTextList(params);
        case "get_style_by_id": return cmdGetStyleById(params);
        case "import_style": return cmdImportStyle(params);
        case "notify": return cmdNotify(params);
        case "undo": return cmdUndo();
        case "client_storage": return cmdClientStorage(params);
        case "node_data": return cmdNodeData(params);
        case "watch_document": return cmdWatchDocument(params);
        case "flatten_nodes": return cmdFlattenNodes(params);
        case "set_layout_grids": return cmdSetLayoutGrids(params);
        case "get_selection_colors": return cmdGetSelectionColors(params);
        case "find_nodes": return cmdFindNodes(params);
        case "rescale_node": return cmdRescaleNode(params);
        case "outline_stroke": return cmdOutlineStroke(params);
        case "create_text_path": return cmdCreateTextPath(params);
        case "get_motion_info": return cmdGetMotionInfo();
        case "get_node_animations": return cmdGetNodeAnimations(params);
        case "apply_motion_style": return cmdApplyMotionStyle(params);
        case "remove_motion_style": return cmdRemoveMotionStyle(params);
        case "set_manual_keyframes": return cmdSetManualKeyframes(params);
        case "remove_manual_keyframes": return cmdRemoveManualKeyframes(params);
        case "set_timeline_duration": return cmdSetTimelineDuration(params);
        case "transform_group": return cmdTransformGroup(params);
        case "get_measurements": return cmdGetMeasurements(params);
        case "get_style_consumers": return cmdGetStyleConsumers(params);
        case "get_component_instances": return cmdGetComponentInstances(params);
        case "create_slot": return cmdCreateSlot(params);
        case "reset_slot": return cmdResetSlot(params);
        case "get_font_axes": return cmdGetFontAxes(params);
        case "set_grid_style": return cmdSetGridStyle(params);
        case "create_page_divider": return cmdCreatePageDivider(params);
        case "get_file_thumbnail": return cmdGetFileThumbnail(params);
        case "set_file_thumbnail": return cmdSetFileThumbnail(params);
        case "open_url": return cmdOpenUrl(params);
        case "set_grid_child": return cmdSetGridChild(params);
        case "set_shape_props": return cmdSetShapeProps(params);
        case "set_aspect_lock": return cmdSetAspectLock(params);
        case "get_transform": return cmdGetTransform(params);
        case "get_plugin_info": return cmdGetPluginInfo();
        case "get_node_binds": return cmdGetNodeBinds(params);
        case "get_vector_geometry": return cmdGetVectorGeometry(params);
        case "set_node_description": return cmdSetNodeDescription(params);
        case "set_dev_status": return cmdSetDevStatus(params);
        default: throw new Error(`unknown command: ${command}`);
    }
}
figma.ui.onmessage = async (msg) => {
    const id = msg?.id;
    const command = msg?.command || msg?.type;
    if (!command || command === "cancel") {
        if (command === "cancel") {
            try {
                figma.closePlugin();
            }
            catch (_e) { }
        }
        return;
    }
    if (command === "resize" && typeof id === "string" && id.indexOf("local-") === 0) {
        try {
            const p = msg?.params || {};
            figma.ui.resize(Math.min(Math.max(Number(p.width) || 340, 70), 2000), Math.min(Math.max(Number(p.height) || 520, 0), 2000));
            figma.ui.postMessage({ id, ok: true, result: {} });
        }
        catch (e) {
            figma.ui.postMessage({ id, ok: false, error: String(e?.message || e) });
        }
        return;
    }
    try {
        const result = await handleCommand(command, msg?.params || {});
        figma.ui.postMessage({ id, ok: true, result });
    }
    catch (e) {
        figma.ui.postMessage({ id, ok: false, error: String(e?.message || e) });
    }
};
// live events -> UI (UI forwards to bridge if anyone subscribed)
figma.on("selectionchange", () => {
    try {
        const sel = figma.currentPage.selection;
        figma.ui.postMessage({ type: "event", event: "selectionchange", data: { count: sel.length, ids: sel.map((n) => n.id) } });
    }
    catch (_e) { }
});
figma.on("currentpagechange", () => {
    try {
        figma.ui.postMessage({ type: "event", event: "currentpagechange", data: { pageId: figma.currentPage.id } });
    }
    catch (_e) { }
});
