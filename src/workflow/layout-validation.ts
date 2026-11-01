export interface LayoutRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type LayoutSurface = "desktop" | "mobile";

export interface LayoutElement {
  id: string;
  rect: LayoutRect;
}

export interface LayoutValidationInput {
  surface: LayoutSurface;
  section: LayoutRect;
  elements: LayoutElement[];
}

export interface LayoutValidationResult {
  surface: LayoutSurface;
  valid: boolean;
  errors: string[];
}

export function validateLayout(input: LayoutValidationInput): LayoutValidationResult {
  const errors: string[] = [];
  const section = input.section;
  if (!isValidRect(section)) {
    return {
      surface: input.surface,
      valid: false,
      errors: [`The ${input.surface} section has an invalid bounding rectangle.`],
    };
  }
  for (const element of input.elements) {
    if (!isValidRect(element.rect)) {
      errors.push(`${element.id} has an invalid bounding rectangle.`);
      continue;
    }
    if (!contains(section, element.rect)) {
      errors.push(`${element.id} extends outside the ${input.surface} section boundary.`);
    }
  }

  for (let leftIndex = 0; leftIndex < input.elements.length; leftIndex += 1) {
    const left = input.elements[leftIndex]!;
    if (!isValidRect(left.rect)) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < input.elements.length; rightIndex += 1) {
      const right = input.elements[rightIndex]!;
      if (isValidRect(right.rect) && overlaps(left.rect, right.rect)) {
        errors.push(`${left.id} overlaps ${right.id} on ${input.surface}.`);
      }
    }
  }

  return { surface: input.surface, valid: errors.length === 0, errors };
}

export function validateResponsiveLayouts(
  layouts: LayoutValidationInput[],
): LayoutValidationResult[] {
  return layouts.map(validateLayout);
}

function isValidRect(rect: LayoutRect): boolean {
  return [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) &&
    rect.width > 0 &&
    rect.height > 0;
}

function contains(section: LayoutRect, element: LayoutRect): boolean {
  return element.x >= section.x &&
    element.y >= section.y &&
    element.x + element.width <= section.x + section.width &&
    element.y + element.height <= section.y + section.height;
}

function overlaps(left: LayoutRect, right: LayoutRect): boolean {
  return left.x < right.x + right.width &&
    left.x + left.width > right.x &&
    left.y < right.y + right.height &&
    left.y + left.height > right.y;
}
