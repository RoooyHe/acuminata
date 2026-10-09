// Tool registry — defines available tools the agent can call.
// Each tool has a name, description, input schema, and a handler function.
// Tools are categorized as "read" (auto-execute) or "write" (needs confirmation).

const TOOLS = [
  {
    name: "search_records",
    description:
      "Search browsing history records by keyword query. Returns matching records with id, url, title, domain, matchedRule, timestamp, pinned, and score fields.",
    category: "read",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Search term to match against record titles and URLs. Use empty string to get all records sorted by recency.",
        },
        limit: {
          type: "number",
          description:
            "Maximum number of records to return (default 50, max 200).",
        },
        min_score: {
          type: "number",
          description:
            "Only return records with score >= this value (default 0).",
        },
        domain: {
          type: "string",
          description: "Filter by matched domain/rule. Use empty for all.",
        },
      },
    },
  },
  {
    name: "get_record_details",
    description:
      "Get full details of a single record by its ID, including all fields.",
    category: "read",
    input_schema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The record ID.",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "get_statistics",
    description:
      "Get current browsing statistics: total records, today's count, tracked sites count, most-visited domain, and per-domain breakdown.",
    category: "read",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_recommendations",
    description:
      "List AI-generated recommendations. Filter by status: 0 = pending, 1 = accepted, -1 = rejected. Default shows pending.",
    category: "read",
    input_schema: {
      type: "object",
      properties: {
        status: {
          type: "number",
          description:
            "Status filter: 0 = pending, 1 = accepted, -1 = rejected.",
        },
        limit: {
          type: "number",
          description: "Maximum results (default 50).",
        },
      },
    },
  },
  {
    name: "get_watchlist",
    description:
      "Get the current watchlist with all domain rules, labels, colors, regex filters, and regex targets.",
    category: "read",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_agent_profile",
    description:
      "Get the agent's current user profile: learned preferences, anti-patterns, domain health assessments, and reflection history.",
    category: "read",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "delete_records",
    description:
      "Delete browsing history records by their IDs. Use this to clean up junk, dead-domain records, or low-quality content the user is not interested in. Provide a reason for the deletion.",
    category: "write",
    input_schema: {
      type: "object",
      properties: {
        ids: {
          type: "array",
          items: { type: "string" },
          description: "Array of record IDs to delete.",
        },
        reason: {
          type: "string",
          description:
            "Brief explanation of why these records are being deleted (for user review).",
        },
      },
      required: ["ids"],
    },
  },
  {
    name: "update_regex_rule",
    description:
      "Update the regex filter for a watchlist domain. This changes how the extension filters incoming URLs for that domain group. The regex can target either the URL ('url') or page title ('title').",
    category: "write",
    input_schema: {
      type: "object",
      properties: {
        domain: {
          type: "string",
          description: "The watchlist domain whose regex rule to update.",
        },
        regex_filter: {
          type: "string",
          description:
            "The new regex pattern. Use empty string to remove filtering.",
        },
        regex_target: {
          type: "string",
          enum: ["url", "title"],
          description:
            "Whether the regex applies to the URL or the page title.",
        },
        reason: {
          type: "string",
          description: "Explanation of why this rule change is suggested.",
        },
      },
      required: ["domain", "regex_filter"],
    },
  },
  {
    name: "update_record_score",
    description:
      "Adjust the score of a pinned record. Score ranges from 0 to 100.",
    category: "write",
    input_schema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "The record ID.",
        },
        score: {
          type: "number",
          description: "New score value (0-100).",
        },
        reason: {
          type: "string",
          description: "Brief explanation of why the score is being adjusted.",
        },
      },
      required: ["id", "score"],
    },
  },
  {
    name: "add_record",
    description:
      "Manually add a new record to the browsing history. Use this to bookmark recommended resources the agent discovered. The record is attributed to a work the same way a browser-reported visit is; if the site's adapter rule does not match the URL, nothing is added.",
    category: "write",
    input_schema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "Full URL of the resource.",
        },
        title: {
          type: "string",
          description: "Title or description of the resource.",
        },
        domain: {
          type: "string",
          description: "The domain (hostname).",
        },
        matched_rule: {
          type: "string",
          description: "The watchlist domain this record falls under.",
        },
        reason: {
          type: "string",
          description: "Why the agent recommends adding this record.",
        },
      },
      required: ["url", "title", "domain", "matched_rule"],
    },
  },
];

function getTool(name) {
  return TOOLS.find((t) => t.name === name);
}

function getReadTools() {
  return TOOLS.filter((t) => t.category === "read");
}

function getWriteTools() {
  return TOOLS.filter((t) => t.category === "write");
}

function getAllTools() {
  return TOOLS;
}

function getOpenAITools() {
  return TOOLS.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

function getAnthropicTools() {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema,
  }));
}

module.exports = {
  TOOLS,
  getTool,
  getReadTools,
  getWriteTools,
  getAllTools,
  getOpenAITools,
  getAnthropicTools,
};
