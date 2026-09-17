import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { getMarketSnapshot } from './market-repository';

export const MCP_TOOL_NAMES = [
  'get_market_overview',
  'get_sector_analysis',
  'get_index_analysis',
  'get_evidence_feed',
  'get_data_freshness',
] as const;

const annotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

function result(data: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data) }],
    structuredContent: data,
  };
}

function error(message: string) {
  return {
    content: [{ type: 'text' as const, text: message }],
    isError: true,
  };
}

export function createMarketMcpServer() {
  const server = new McpServer({
    name: 'strongest-analyst-market-intelligence',
    version: '1.0.0',
  });

  server.registerTool(
    'get_market_overview',
    {
      title: '市场概览',
      description:
        '读取 A 股、美股行业或全球主流指数的近实时信息面概览。只读，不提供投资建议。',
      inputSchema: z.object({
        market: z.enum(['CN', 'US', 'INDEX', 'ALL']).default('ALL'),
      }),
      annotations,
    },
    async ({ market }) => {
      const snapshot = await getMarketSnapshot();
      const groups = {
        CN: { summary: snapshot.market, items: snapshot.sectors },
        US: { summary: snapshot.usMarket, items: snapshot.usSectors },
        INDEX: { summary: snapshot.indexMarket, items: snapshot.indexes },
      };
      const selected: Array<
        [keyof typeof groups, (typeof groups)[keyof typeof groups]]
      > =
        market === 'ALL'
          ? (Object.entries(groups) as Array<
              [keyof typeof groups, (typeof groups)[keyof typeof groups]]
            >)
          : [[market, groups[market]]];
      return result({
        tradeDate: snapshot.tradeDate,
        updatedAt: snapshot.updatedAt,
        dataStatus: snapshot.dataStatus,
        markets: Object.fromEntries(
          selected.map(([key, group]) => [
            key,
            {
              summary: group.summary,
              freshness: snapshot.freshness[key as 'CN' | 'US' | 'INDEX'],
              items: group.items.map((item) => ({
                code: item.code,
                name: item.name,
                change: item.change,
                informationTone: item.informationTone,
                evidenceQuality: item.evidenceQuality,
              })),
            },
          ]),
        ),
        readOnly: true,
        disclaimer: snapshot.disclaimer,
      });
    },
  );

  server.registerTool(
    'get_sector_analysis',
    {
      title: '行业信息分析',
      description:
        '按代码读取 A 股或美股行业的信息面结论、行情与可核验证据链。',
      inputSchema: z.object({ code: z.string().min(2).max(24) }),
      annotations,
    },
    async ({ code }) => {
      const snapshot = await getMarketSnapshot();
      const sector = [...snapshot.sectors, ...snapshot.usSectors].find(
        (item) => item.code.toUpperCase() === code.toUpperCase(),
      );
      if (!sector) return error(`未找到行业代码：${code}`);
      return result({
        tradeDate: snapshot.tradeDate,
        updatedAt: snapshot.updatedAt,
        dataStatus: snapshot.dataStatus,
        sector,
        providerStatus: snapshot.providerStatus,
        proxyDisclosure: snapshot.proxyDisclosure,
        readOnly: true,
        disclaimer: snapshot.disclaimer,
      });
    },
  );

  server.registerTool(
    'get_index_analysis',
    {
      title: '主流指数信息分析',
      description: '按代码读取国内外主流指数或其公开 ETF 代理的分析与披露。',
      inputSchema: z.object({ code: z.string().min(2).max(24) }),
      annotations,
    },
    async ({ code }) => {
      const snapshot = await getMarketSnapshot();
      const index = snapshot.indexes.find(
        (item) => item.code.toUpperCase() === code.toUpperCase(),
      );
      if (!index) return error(`未找到指数代码：${code}`);
      return result({
        tradeDate: snapshot.tradeDate,
        updatedAt: snapshot.updatedAt,
        dataStatus: snapshot.dataStatus,
        index,
        providerStatus: snapshot.providerStatus,
        proxyDisclosure: snapshot.proxyDisclosure,
        readOnly: true,
        disclaimer: snapshot.disclaimer,
      });
    },
  );

  server.registerTool(
    'get_evidence_feed',
    {
      title: '公开证据信息流',
      description:
        '读取新闻、宏观信息、财报与公告证据；A 股信息因子按海外 60%、国内 40% 解释。',
      inputSchema: z.object({
        market: z.enum(['CN', 'US', 'INDEX', 'ALL']).default('ALL'),
        limit: z.number().int().min(1).max(50).default(20),
      }),
      annotations,
    },
    async ({ market, limit }) => {
      const snapshot = await getMarketSnapshot();
      const events = snapshot.events
        .filter((event) => market === 'ALL' || event.region === market)
        .slice(0, limit);
      return result({
        tradeDate: snapshot.tradeDate,
        updatedAt: snapshot.updatedAt,
        dataStatus: snapshot.dataStatus,
        weighting:
          market === 'CN' || market === 'ALL'
            ? {
                overseasMainstreamAndEconomists: 0.6,
                domesticNewsAndAnnouncements: 0.4,
              }
            : undefined,
        events,
        readOnly: true,
        disclaimer: snapshot.disclaimer,
      });
    },
  );

  server.registerTool(
    'get_data_freshness',
    {
      title: '数据新鲜度',
      description:
        '读取各市场行情时间、接收时间、延迟等级、代理披露和提供者健康度。',
      inputSchema: z.object({}),
      annotations,
    },
    async () => {
      const snapshot = await getMarketSnapshot();
      return result({
        tradeDate: snapshot.tradeDate,
        updatedAt: snapshot.updatedAt,
        dataStatus: snapshot.dataStatus,
        freshness: snapshot.freshness,
        providerStatus: snapshot.providerStatus,
        proxyDisclosure: snapshot.proxyDisclosure,
        readOnly: true,
        disclaimer: snapshot.disclaimer,
      });
    },
  );

  return server;
}
