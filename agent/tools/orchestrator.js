// Orchestrator for agent tool execution.
// Wires pure handlers to side-effect-producing context, enforcing read/write separation.

const { getHandler, getAllHandlerNames } = require("./handlers");

function createExecuteTool(ctx) {
  const {
    writeStore,
    watchlist,
    triggerReflectionOnDelete,
    readStore,
  } = ctx;

  function executeRead(name, args) {
    const handler = getHandler(name);
    if (!handler) return { error: "Unknown tool: " + name };
    try {
      return handler(args, { readStore, watchlist });
    } catch (e) {
      return { error: "Tool execution failed: " + e.message };
    }
  }

  function executeWrite(name, args) {
    const handler = getHandler(name);
    if (!handler) return { error: "Unknown tool: " + name };

    const computed = handler(args, { readStore, watchlist });
    if (computed.error) return computed;
    const se = computed._sideEffects;

    if (name === "delete_records" && se) {
      const { deleteIds, reason } = se;
      const { deletedCount, deletedRecords } = writeStore.deleteRecords(deleteIds);
      if (deletedRecords.length > 0) {
        setImmediate(() => triggerReflectionOnDelete(deletedRecords));
      }
      return { deleted: deletedCount, reason };
    }

    if (name === "update_regex_rule" && se) {
      const { domain, regexFilter, regexTarget, reason } = se;
      const updated = writeStore.updateWatchlistRegex(
        domain,
        regexFilter,
        regexTarget,
      );
      if (!updated) return { error: "Domain not found in watchlist" };
      return {
        updated: domain,
        regex_filter: regexFilter,
        regex_target: regexTarget,
        reason,
      };
    }

    if (name === "update_record_score" && se) {
      const { id, score } = se;
      const record = writeStore.updateRecordScore(id, score);
      return record ? { updated: id, score } : { error: "Record not found" };
    }

    if (name === "add_record" && se) {
      const { record, reason } = se;
      writeStore.addAgentRecord(record);
      return { added: record.id, url: record.url, reason };
    }

    return computed;
  }

  function executeTool(name, args) {
    const tool = ctx.getTool(name);
    if (tool && tool.category === "write") {
      return executeWrite(name, args);
    }
    return executeRead(name, args);
  }

  executeTool.executeRead = executeRead;
  executeTool.executeWrite = executeWrite;
  executeTool.getAllHandlerNames = getAllHandlerNames;

  return executeTool;
}

module.exports = {
  createExecuteTool,
};
