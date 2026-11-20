export const SITE_URL = 'https://phonewebcam.pages.dev';
export const OG_IMAGE_URL = `${SITE_URL}/og-image.png`;
export const SITE_NAME = 'PhoneWebcam';

export interface BreadcrumbItem {
  label: string;
  href?: string;
}

export interface FaqEntry {
  question: string;
  answer: string;
}

export interface HowToStepInput {
  name: string;
  text: string;
  url?: string;
  image?: string;
}

export interface SitemapRoute {
  path: string;
  changefreq: 'daily' | 'weekly' | 'monthly' | 'yearly';
  priority: string;
}

export const CANONICAL_ROUTES: readonly SitemapRoute[] = [
  { path: '/', changefreq: 'weekly', priority: '1.0' },
  { path: '/how-to-use', changefreq: 'monthly', priority: '0.9' },
  { path: '/google-meet', changefreq: 'monthly', priority: '0.9' },
  { path: '/zoom', changefreq: 'monthly', priority: '0.9' },
  { path: '/obs', changefreq: 'monthly', priority: '0.9' },
  { path: '/hire-me', changefreq: 'monthly', priority: '0.7' },
  { path: '/privacy', changefreq: 'yearly', priority: '0.5' },
] as const;

export function toCanonicalUrl(path: string): string {
  if (!path || path === '/') return `${SITE_URL}/`;
  const normalized = path.startsWith('/') ? path.replace(/\/+$/, '') : `/${path.replace(/\/+$/, '')}`;
  return `${SITE_URL}${normalized}`;
}

export function buildWebApplicationSchema(description: string): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebApplication',
    name: SITE_NAME,
    url: `${SITE_URL}/`,
    description,
    applicationCategory: 'UtilitiesApplication',
    operatingSystem: 'Any (Web Browser)',
    browserRequirements: 'Requires a modern WebRTC-enabled browser (Chrome, Edge, Safari, or Firefox).',
    isAccessibleForFree: true,
    offers: {
      '@type': 'Offer',
      price: '0',
      priceCurrency: 'USD',
    },
    author: {
      '@type': 'Person',
      name: 'Kishara Dilshan',
      url: toCanonicalUrl('/hire-me'),
    },
  };
}

export function buildFaqSchema(items: readonly FaqEntry[]): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: items.map((item) => ({
      '@type': 'Question',
      name: item.question,
      acceptedAnswer: {
        '@type': 'Answer',
        text: item.answer,
      },
    })),
  };
}

export function buildBreadcrumbSchema(items: readonly BreadcrumbItem[]): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, idx) => {
      const entry: Record<string, unknown> = {
        '@type': 'ListItem',
        position: idx + 1,
        name: item.label,
      };
      if (item.href) {
        entry.item = toCanonicalUrl(item.href);
      }
      return entry;
    }),
  };
}

export function buildHowToSchema(params: {
  name: string;
  description: string;
  totalTime?: string;
  steps: readonly HowToStepInput[];
}): Record<string, unknown> {
  const schema: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'HowTo',
    name: params.name,
    description: params.description,
    tool: [
      { '@type': 'HowToTool', name: 'Smartphone with browser (Safari on iOS or Chrome on Android)' },
      { '@type': 'HowToTool', name: 'PC or Mac connected to the same Wi-Fi network' },
    ],
    step: params.steps.map((step, idx) => {
      const item: Record<string, unknown> = {
        '@type': 'HowToStep',
        position: idx + 1,
        name: step.name,
        text: step.text,
      };
      if (step.url) {
        item.url = toCanonicalUrl(step.url);
      }
      if (step.image) {
        item.image = toCanonicalUrl(step.image);
      }
      return item;
    }),
  };

  if (params.totalTime) {
    schema.totalTime = params.totalTime;
  }

  return schema;
}

export function buildPersonSchema(): Record<string, unknown> {
  return {
    '@context': 'https://schema.org',
    '@type': 'Person',
    name: 'Kishara Dilshan',
    jobTitle: 'Freelance Full-Stack Web & Client-Side Tool Developer',
    description:
      'Creator of PhoneWebcam specializing in ultra-fast Astro, React, and Next.js web applications, client-side WebAssembly (WASM) tools, and high-converting UI/UX design.',
    url: toCanonicalUrl('/hire-me'),
    email: 'mailto:kisharadilshan007@gmail.com',
    sameAs: [
      'https://github.com/Kishara007',
      'https://github.com/Kishara007/phonewebcam',
      'https://kisharadilshan.gumroad.com/coffee',
    ],
    knowsAbout: [
      'Astro',
      'React',
      'Next.js',
      'WebRTC',
      'WebAssembly (WASM)',
      'Technical SEO',
      'UI/UX Design',
    ],
  };
}
