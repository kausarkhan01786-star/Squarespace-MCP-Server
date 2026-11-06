import type { CmsId } from "../capabilities/capability-types.js";
import type { OperationResult } from "./adapter-result.js";

export interface AdapterMetadata {
  readonly cms: CmsId;
  readonly adapterId: string;
  readonly contractVersion: string;
}

export interface AdapterSiteIdentity {
  readonly cms: CmsId;
  readonly siteId: string;
}

export interface AdapterContext {
  readonly site: AdapterSiteIdentity;
  readonly requestId: string;
  readonly signal: AbortSignal;
}

export interface ProviderSpecificData {
  readonly providerId: string;
  readonly originalPayload: unknown;
  readonly sourceMetadata: Readonly<Record<string, string | number | boolean | null>>;
}

export interface Site {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly providerData: ProviderSpecificData;
}

export interface Page {
  readonly id: string;
  readonly siteId: string;
  readonly title: string;
  readonly slug: string | null;
  readonly url: string | null;
  readonly providerData: ProviderSpecificData;
}

export interface Layout {
  readonly kind: "flow" | "grid" | "absolute" | "provider_defined";
  readonly columns?: number;
  readonly gap?: string;
  readonly providerData?: ProviderSpecificData;
}

export interface DesignToken {
  readonly name: string;
  readonly value: string;
  readonly role?: string;
  readonly providerData?: ProviderSpecificData;
}

export interface ResponsiveStyle {
  readonly breakpoint: string;
  readonly properties: Readonly<Record<string, string | number | boolean | null>>;
  readonly providerData?: ProviderSpecificData;
}

export interface Section {
  readonly id: string;
  readonly pageId: string;
  readonly order: number;
  readonly layout: Layout | null;
  readonly providerData: ProviderSpecificData;
}

export type BlockContent =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "image"; readonly assetId: string; readonly altText: string | null }
  | { readonly kind: "button"; readonly label: string; readonly destination: string }
  | { readonly kind: "unknown"; readonly originalSourceType: string; readonly originalPayload: unknown };

export interface Block {
  readonly id: string;
  readonly sectionId: string;
  readonly content: BlockContent;
  readonly providerData: ProviderSpecificData;
}

export interface Asset {
  readonly id: string;
  readonly mediaType: "image" | "video" | "file" | "unknown";
  readonly url: string | null;
  readonly providerData: ProviderSpecificData;
}

export interface DesignSystem {
  readonly tokens: readonly DesignToken[];
  readonly responsiveStyles: readonly ResponsiveStyle[];
  readonly providerData: ProviderSpecificData;
}

export interface SEOConfiguration {
  readonly title: string | null;
  readonly description: string | null;
  readonly providerData: ProviderSpecificData;
}

export interface PageInput {
  readonly title: string;
  readonly slug?: string;
}

export interface PageUpdate {
  readonly title?: string;
  readonly slug?: string;
}

export interface SectionInput {
  readonly layout: Layout;
}

export interface BlockInput {
  readonly content: BlockContent;
}

export interface AssetInput {
  readonly mediaType: "image" | "video" | "file";
  readonly source: string;
}

export interface DesignSystemUpdate {
  readonly tokens: readonly DesignToken[];
  readonly responsiveStyles: readonly ResponsiveStyle[];
}

export interface Snapshot {
  readonly id: string;
  readonly siteId: string;
  readonly pageId: string;
  readonly createdAt: string;
  readonly providerData: ProviderSpecificData;
}

export interface CMSAdapter {
  readonly metadata: AdapterMetadata;
}

export interface SiteInspector {
  inspectSite(context: AdapterContext): Promise<OperationResult<Site>>;
}

export interface PageOperations {
  listPages(context: AdapterContext): Promise<OperationResult<readonly Page[]>>;
  inspectPage(context: AdapterContext, pageId: string): Promise<OperationResult<Page>>;
  createPage(context: AdapterContext, input: PageInput): Promise<OperationResult<Page>>;
  updatePage(context: AdapterContext, pageId: string, input: PageUpdate): Promise<OperationResult<Page>>;
  deletePage(context: AdapterContext, pageId: string): Promise<OperationResult<void>>;
}

export interface SectionOperations {
  listSections(context: AdapterContext, pageId: string): Promise<OperationResult<readonly Section[]>>;
  inspectSection(context: AdapterContext, sectionId: string): Promise<OperationResult<Section>>;
  createSection(context: AdapterContext, pageId: string, input: SectionInput): Promise<OperationResult<Section>>;
  updateSection(context: AdapterContext, sectionId: string, input: SectionInput): Promise<OperationResult<Section>>;
  deleteSection(context: AdapterContext, sectionId: string): Promise<OperationResult<void>>;
}

export interface BlockOperations {
  listBlocks(context: AdapterContext, sectionId: string): Promise<OperationResult<readonly Block[]>>;
  inspectBlock(context: AdapterContext, blockId: string): Promise<OperationResult<Block>>;
  createBlock(context: AdapterContext, sectionId: string, input: BlockInput): Promise<OperationResult<Block>>;
  updateBlock(context: AdapterContext, blockId: string, input: BlockInput): Promise<OperationResult<Block>>;
  deleteBlock(context: AdapterContext, blockId: string): Promise<OperationResult<void>>;
}

export interface AssetOperations {
  listAssets(context: AdapterContext): Promise<OperationResult<readonly Asset[]>>;
  uploadAsset(context: AdapterContext, input: AssetInput): Promise<OperationResult<Asset>>;
  deleteAsset(context: AdapterContext, assetId: string): Promise<OperationResult<void>>;
}

export interface DesignOperations {
  inspectDesignSystem(context: AdapterContext): Promise<OperationResult<DesignSystem>>;
  updateDesignSystem(context: AdapterContext, update: DesignSystemUpdate): Promise<OperationResult<DesignSystem>>;
}

export interface SEOOperations {
  inspectPageSEO(context: AdapterContext, pageId: string): Promise<OperationResult<SEOConfiguration>>;
  updatePageSEO(context: AdapterContext, pageId: string, update: SEOConfiguration): Promise<OperationResult<SEOConfiguration>>;
}

export interface PublishingOperations {
  savePage(context: AdapterContext, pageId: string): Promise<OperationResult<void>>;
  publishPage(context: AdapterContext, pageId: string): Promise<OperationResult<void>>;
}

export interface SnapshotOperations {
  createSnapshot(context: AdapterContext, pageId: string): Promise<OperationResult<Snapshot>>;
}