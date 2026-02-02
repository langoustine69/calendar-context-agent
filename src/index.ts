import { createAgent } from '@lucid-agents/core';
import { http } from '@lucid-agents/http';
import { createAgentApp } from '@lucid-agents/hono';
import { payments, paymentsFromEnv } from '@lucid-agents/payments';
import { analytics, getSummary, getAllTransactions, exportToCSV } from '@lucid-agents/analytics';
import { z } from 'zod';

const agent = await createAgent({
  name: 'calendar-context-agent',
  version: '1.0.0',
  description: 'Date context for AI agents — holidays, historical events, births, deaths. Know what day it is.',
})
  .use(http())
  .use(payments({ config: paymentsFromEnv() }))
  .use(analytics())
  .build();

const { app, addEntrypoint } = await createAgentApp(agent);

// === HELPER FUNCTIONS ===
async function fetchJSON(url: string, timeout = 10000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`API error: ${response.status}`);
    return response.json();
  } finally {
    clearTimeout(timeoutId);
  }
}

function getMonthDay(dateStr?: string) {
  const date = dateStr ? new Date(dateStr) : new Date();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return { month, day, year: date.getFullYear(), dateObj: date };
}

// === FREE ENDPOINT: Today's Overview ===
addEntrypoint({
  key: 'today',
  description: 'Free overview of today — current date, day of week, notable info. Try before you buy.',
  input: z.object({}),
  // free endpoint - no price
  handler: async () => {
    const now = new Date();
    const { month, day } = getMonthDay();
    
    // Fetch today's holidays for US
    let holidays: any[] = [];
    try {
      const holidayData = await fetchJSON(`https://date.nager.at/api/v3/PublicHolidays/${now.getFullYear()}/US`);
      const today = now.toISOString().split('T')[0];
      holidays = holidayData.filter((h: any) => h.date === today);
    } catch (e) {
      // Continue without holiday data
    }
    
    return {
      output: {
        date: now.toISOString().split('T')[0],
        dayOfWeek: now.toLocaleDateString('en-US', { weekday: 'long' }),
        month: now.toLocaleDateString('en-US', { month: 'long' }),
        dayOfYear: Math.floor((now.getTime() - new Date(now.getFullYear(), 0, 0).getTime()) / 86400000),
        week: Math.ceil((now.getTime() - new Date(now.getFullYear(), 0, 1).getTime()) / 604800000),
        holidays: holidays.map((h: any) => ({ name: h.name, localName: h.localName })),
        isWeekend: now.getDay() === 0 || now.getDay() === 6,
        quarter: Math.ceil((now.getMonth() + 1) / 3),
        fetchedAt: now.toISOString(),
        dataSource: 'Nager.at Public Holiday API (live)',
        endpoints: {
          free: ['today'],
          paid: ['holidays', 'events', 'births', 'full-context', 'compare-dates']
        }
      }
    };
  },
});

// === PAID ENDPOINT 1 ($0.001): Holidays by Country ===
addEntrypoint({
  key: 'holidays',
  description: 'Public holidays for any country and year',
  input: z.object({
    country: z.string().length(2).describe('ISO 3166-1 alpha-2 country code (e.g., US, GB, DE, AU)'),
    year: z.number().optional().describe('Year (default: current year)')
  }),
  price: "1000",
  handler: async (ctx) => {
    const year = ctx.input.year || new Date().getFullYear();
    const country = ctx.input.country.toUpperCase();
    
    const holidays = await fetchJSON(`https://date.nager.at/api/v3/PublicHolidays/${year}/${country}`);
    
    return {
      output: {
        country,
        year,
        count: holidays.length,
        holidays: holidays.map((h: any) => ({
          date: h.date,
          name: h.name,
          localName: h.localName,
          isGlobal: h.global,
          types: h.types
        })),
        fetchedAt: new Date().toISOString(),
        dataSource: 'Nager.at Public Holiday API (live)'
      }
    };
  },
});

// === PAID ENDPOINT 2 ($0.002): Historical Events ===
addEntrypoint({
  key: 'events',
  description: 'Historical events that happened on a specific date',
  input: z.object({
    month: z.number().min(1).max(12).describe('Month (1-12)'),
    day: z.number().min(1).max(31).describe('Day of month'),
    limit: z.number().optional().default(10).describe('Max events to return')
  }),
  price: "2000",
  handler: async (ctx) => {
    const mm = String(ctx.input.month).padStart(2, '0');
    const dd = String(ctx.input.day).padStart(2, '0');
    
    const data = await fetchJSON(
      `https://en.wikipedia.org/api/rest_v1/feed/onthisday/events/${mm}/${dd}`,
      15000
    );
    
    const events = data.events?.slice(0, ctx.input.limit) || [];
    
    return {
      output: {
        date: `${mm}-${dd}`,
        count: events.length,
        events: events.map((e: any) => ({
          year: e.year,
          text: e.text,
          pages: e.pages?.slice(0, 2).map((p: any) => ({
            title: p.title,
            description: p.description,
            url: p.content_urls?.desktop?.page
          }))
        })),
        fetchedAt: new Date().toISOString(),
        dataSource: 'Wikipedia On This Day API (live)'
      }
    };
  },
});

// === PAID ENDPOINT 3 ($0.002): Notable Births ===
addEntrypoint({
  key: 'births',
  description: 'Notable people born on a specific date',
  input: z.object({
    month: z.number().min(1).max(12).describe('Month (1-12)'),
    day: z.number().min(1).max(31).describe('Day of month'),
    limit: z.number().optional().default(10).describe('Max births to return')
  }),
  price: "2000",
  handler: async (ctx) => {
    const mm = String(ctx.input.month).padStart(2, '0');
    const dd = String(ctx.input.day).padStart(2, '0');
    
    const data = await fetchJSON(
      `https://en.wikipedia.org/api/rest_v1/feed/onthisday/births/${mm}/${dd}`,
      15000
    );
    
    const births = data.births?.slice(0, ctx.input.limit) || [];
    
    return {
      output: {
        date: `${mm}-${dd}`,
        count: births.length,
        births: births.map((b: any) => ({
          year: b.year,
          text: b.text,
          pages: b.pages?.slice(0, 1).map((p: any) => ({
            title: p.title,
            description: p.description,
            url: p.content_urls?.desktop?.page
          }))
        })),
        fetchedAt: new Date().toISOString(),
        dataSource: 'Wikipedia On This Day API (live)'
      }
    };
  },
});

// === PAID ENDPOINT 4 ($0.003): Full Context ===
addEntrypoint({
  key: 'full-context',
  description: 'Complete date context — holidays, events, births all in one call',
  input: z.object({
    date: z.string().optional().describe('Date in YYYY-MM-DD format (default: today)'),
    country: z.string().length(2).optional().default('US').describe('Country for holidays')
  }),
  price: "3000",
  handler: async (ctx) => {
    const { month, day, year, dateObj } = getMonthDay(ctx.input.date);
    const country = ctx.input.country?.toUpperCase() || 'US';
    const dateStr = dateObj.toISOString().split('T')[0];
    
    // Fetch all data in parallel
    const [holidayData, eventsData, birthsData] = await Promise.allSettled([
      fetchJSON(`https://date.nager.at/api/v3/PublicHolidays/${year}/${country}`),
      fetchJSON(`https://en.wikipedia.org/api/rest_v1/feed/onthisday/events/${month}/${day}`, 15000),
      fetchJSON(`https://en.wikipedia.org/api/rest_v1/feed/onthisday/births/${month}/${day}`, 15000)
    ]);
    
    // Process holidays
    let holidays: any[] = [];
    if (holidayData.status === 'fulfilled') {
      holidays = holidayData.value
        .filter((h: any) => h.date === dateStr)
        .map((h: any) => ({ name: h.name, localName: h.localName }));
    }
    
    // Process events
    let events: any[] = [];
    if (eventsData.status === 'fulfilled') {
      events = eventsData.value.events?.slice(0, 5).map((e: any) => ({
        year: e.year,
        text: e.text
      })) || [];
    }
    
    // Process births
    let births: any[] = [];
    if (birthsData.status === 'fulfilled') {
      births = birthsData.value.births?.slice(0, 5).map((b: any) => ({
        year: b.year,
        text: b.text
      })) || [];
    }
    
    return {
      output: {
        date: dateStr,
        dayOfWeek: dateObj.toLocaleDateString('en-US', { weekday: 'long' }),
        country,
        holidays,
        historicalEvents: events,
        notableBirths: births,
        isWeekend: dateObj.getDay() === 0 || dateObj.getDay() === 6,
        fetchedAt: new Date().toISOString(),
        dataSources: ['Nager.at Public Holiday API', 'Wikipedia On This Day API']
      }
    };
  },
});

// === PAID ENDPOINT 5 ($0.005): Compare Dates ===
addEntrypoint({
  key: 'compare-dates',
  description: 'Compare multiple dates — find common themes, differences, special days',
  input: z.object({
    dates: z.array(z.string()).min(2).max(5).describe('Array of dates in YYYY-MM-DD format'),
    country: z.string().length(2).optional().default('US')
  }),
  price: "5000",
  handler: async (ctx) => {
    const country = ctx.input.country?.toUpperCase() || 'US';
    const years = [...new Set(ctx.input.dates.map(d => new Date(d).getFullYear()))];
    
    // Fetch holidays for all relevant years
    const holidayPromises = years.map(y => 
      fetchJSON(`https://date.nager.at/api/v3/PublicHolidays/${y}/${country}`)
        .then(data => ({ year: y, holidays: data }))
        .catch(() => ({ year: y, holidays: [] }))
    );
    
    const holidaysByYear = await Promise.all(holidayPromises);
    const allHolidays = holidaysByYear.flatMap(h => h.holidays);
    
    // Analyze each date
    const comparisons = ctx.input.dates.map(dateStr => {
      const date = new Date(dateStr);
      const isoDate = dateStr;
      const holidays = allHolidays
        .filter((h: any) => h.date === isoDate)
        .map((h: any) => h.name);
      
      return {
        date: isoDate,
        dayOfWeek: date.toLocaleDateString('en-US', { weekday: 'long' }),
        isWeekend: date.getDay() === 0 || date.getDay() === 6,
        holidays,
        isHoliday: holidays.length > 0
      };
    });
    
    // Find patterns
    const weekendCount = comparisons.filter(c => c.isWeekend).length;
    const holidayCount = comparisons.filter(c => c.isHoliday).length;
    
    return {
      output: {
        country,
        dateCount: comparisons.length,
        comparisons,
        summary: {
          weekends: weekendCount,
          holidays: holidayCount,
          allWeekends: weekendCount === comparisons.length,
          allHolidays: holidayCount === comparisons.length,
          noWeekends: weekendCount === 0
        },
        fetchedAt: new Date().toISOString(),
        dataSource: 'Nager.at Public Holiday API (live)'
      }
    };
  },
});

// === ANALYTICS ENDPOINTS (FREE) ===
addEntrypoint({
  key: 'analytics',
  description: 'Payment analytics summary',
  input: z.object({
    windowMs: z.number().optional().describe('Time window in ms (e.g., 86400000 for 24h)')
  }),
  // free endpoint - no price
  handler: async (ctx) => {
    const tracker = agent.analytics?.paymentTracker;
    if (!tracker) {
      return { output: { error: 'Analytics not available', payments: [] } };
    }
    const summary = await getSummary(tracker, ctx.input.windowMs);
    return { 
      output: { 
        ...summary,
        outgoingTotal: summary.outgoingTotal.toString(),
        incomingTotal: summary.incomingTotal.toString(),
        netTotal: summary.netTotal.toString(),
      } 
    };
  },
});

addEntrypoint({
  key: 'analytics-transactions',
  description: 'Recent payment transactions',
  input: z.object({
    windowMs: z.number().optional(),
    limit: z.number().optional().default(50)
  }),
  // free endpoint - no price
  handler: async (ctx) => {
    const tracker = agent.analytics?.paymentTracker;
    if (!tracker) {
      return { output: { transactions: [] } };
    }
    const txs = await getAllTransactions(tracker, ctx.input.windowMs);
    return { output: { transactions: txs.slice(0, ctx.input.limit) } };
  },
});

addEntrypoint({
  key: 'analytics-csv',
  description: 'Export payment data as CSV',
  input: z.object({ windowMs: z.number().optional() }),
  // free endpoint - no price
  handler: async (ctx) => {
    const tracker = agent.analytics?.paymentTracker;
    if (!tracker) {
      return { output: { csv: '' } };
    }
    const csv = await exportToCSV(tracker, ctx.input.windowMs);
    return { output: { csv } };
  },
});

// Serve icon
app.get('/icon.png', async (c) => {
  try {
    const file = Bun.file('./icon.png');
    if (await file.exists()) {
      return new Response(await file.arrayBuffer(), {
        headers: { 'Content-Type': 'image/png' }
      });
    }
  } catch {}
  return c.text('Icon not found', 404);
});

// ERC-8004 registration endpoint
app.get('/.well-known/erc8004.json', (c) => {
  const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN 
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : 'https://calendar-context-agent-production.up.railway.app';
  return c.json({
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: "calendar-context-agent",
    description: "Date context for AI agents — holidays, historical events, notable births. Know what day it is. 1 free + 5 paid endpoints via x402.",
    image: `${baseUrl}/icon.png`,
    services: [
      { name: "web", endpoint: baseUrl },
      { name: "A2A", endpoint: `${baseUrl}/.well-known/agent.json`, version: "0.3.0" }
    ],
    x402Support: true,
    active: true,
    registrations: [],
    supportedTrust: ["reputation"]
  });
});

const port = Number(process.env.PORT ?? 3000);
console.log(`Calendar Context Agent running on port ${port}`);

export default { port, fetch: app.fetch };
