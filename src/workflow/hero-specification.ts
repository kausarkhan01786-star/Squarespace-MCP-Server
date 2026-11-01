import { z } from "zod";
import {
  validateResponsiveLayouts,
  type LayoutElement,
  type LayoutRect,
} from "./layout-validation.js";

const hexColorSchema = z.string().regex(/^#[0-9A-Fa-f]{6}$/);
const layoutRectSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().positive().finite(),
  height: z.number().positive().finite(),
}).strict();

export const heroElementIds = [
  "eyebrow",
  "heading",
  "description",
  "primary_button",
  "secondary_button",
  "visual",
] as const;

export type HeroElementId = typeof heroElementIds[number];

const buttonSchema = z.object({
  label: z.string().trim().min(1).max(80),
  destination: z.string().trim().min(1).max(2_048).refine(isSafeButtonDestination, {
    message: "Button destinations must be a site-relative path or credential-free HTTPS URL.",
  }).optional(),
  variant: z.enum(["primary", "secondary"]),
}).strict();

const responsiveLayoutSchema = z.object({
  section: layoutRectSchema,
  elementOrder: z.array(z.enum(heroElementIds)).min(1),
  positions: z.record(z.enum(heroElementIds), layoutRectSchema),
}).strict();

export const heroSpecificationSchema = z.object({
  content: z.object({
    eyebrow: z.string().trim().min(1).max(120),
    heading: z.string().trim().min(1).max(240),
    description: z.string().trim().min(1).max(1_000),
    buttons: z.tuple([buttonSchema, buttonSchema]).refine(
      ([primary, secondary]) =>
        primary.variant === "primary" &&
        secondary.variant === "secondary" &&
        primary.label.toLocaleLowerCase() !== secondary.label.toLocaleLowerCase(),
      { message: "Provide distinct primary and secondary button labels in that order." },
    ),
    visual: z.object({
      kind: z.enum(["image", "decorative"]),
      assetId: z.string().trim().min(1).optional(),
      description: z.string().trim().min(1).max(300),
    }).strict().refine(
      (visual) => visual.kind !== "image" || visual.assetId !== undefined,
      { message: "An image visual requires an assetId." },
    ),
  }).strict(),
  styling: z.object({
    backgroundColor: hexColorSchema,
    textColor: hexColorSchema,
    typography: z.object({
      headingPreset: z.string().trim().min(1).max(80),
      bodyPreset: z.string().trim().min(1).max(80),
      alignment: z.enum(["left", "center", "right"]),
    }).strict(),
    spacing: z.object({
      top: z.number().min(0).max(1_000),
      bottom: z.number().min(0).max(1_000),
      gap: z.number().min(0).max(500),
    }).strict(),
  }).strict(),
  layout: z.object({
    desktop: responsiveLayoutSchema,
    mobile: responsiveLayoutSchema,
  }).strict(),
}).strict().superRefine((spec, context) => {
  for (const surface of ["desktop", "mobile"] as const) {
    const layout = spec.layout[surface];
    const expected = new Set<HeroElementId>(heroElementIds);
    const positions = Object.keys(layout.positions);
    const order = layout.elementOrder;
    if (
      positions.length !== expected.size ||
      positions.some((id) => !expected.has(id as HeroElementId)) ||
      order.length !== expected.size ||
      new Set(order).size !== expected.size ||
      order.some((id) => !expected.has(id))
    ) {
      context.addIssue({
        code: "custom",
        path: ["layout", surface],
        message: "Each Hero element must have exactly one position and one ordering entry.",
      });
    }
    if (
      order.indexOf("eyebrow") > order.indexOf("heading") ||
      order.indexOf("heading") > order.indexOf("description") ||
      order.indexOf("primary_button") > order.indexOf("secondary_button")
    ) {
      context.addIssue({
        code: "custom",
        path: ["layout", surface, "elementOrder"],
        message: "Hero copy and primary/secondary calls to action are in the wrong order.",
      });
    }
    const layoutResult = validateResponsiveLayouts([{
      surface,
      section: layout.section,
      elements: heroElementIds.flatMap((id) => {
        const rect = layout.positions[id];
        return rect ? [{ id, rect: rect as LayoutRect } satisfies LayoutElement] : [];
      }),
    }])[0]!;
    for (const error of layoutResult.errors) {
      context.addIssue({
        code: "custom",
        path: ["layout", surface],
        message: error,
      });
    }
  }
});

export type HeroSpecification = z.infer<typeof heroSpecificationSchema>;

export function parseHeroSpecification(input: unknown): HeroSpecification {
  return heroSpecificationSchema.parse(input);
}

function isSafeButtonDestination(destination: string): boolean {
  if (destination.startsWith("/") && !destination.startsWith("//")) return true;
  try {
    const url = new URL(destination);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}
