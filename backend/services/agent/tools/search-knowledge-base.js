'use strict';

const rag = require('../../agent-rag');

const schema = {
  name: 'search_knowledge_base',
  description: 'Найти в базе знаний салона информацию об услугах, ценах, ' +
    'противопоказаниях, уходе. Использовать ВСЕГДА, прежде чем отвечать по существу — ' +
    'не выдумывать факты. Возвращает релевантный контекст и актуальные цены.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Вопрос или тема на русском (например «ботокс цена»).' },
    },
    required: ['query'],
    additionalProperties: false,
  },
};

async function run(salonId, input) {
  const query = String((input && input.query) || '').trim();
  if (!query) return { found: false, context: '', sources: [] };
  try {
    const { context, sources } = await rag.buildKnowledgeContext(salonId, query, {});
    return { found: !!context, context, sources };
  } catch (e) {
    // Не превращаем сбой поиска в «технические сложности»: отдаём мягкий found:false
    // (без error), чтобы модель ответила из других инструментов или предложила оператора.
    return { found: false, context: '', sources: [], degraded: true };
  }
}

module.exports = { schema, run };
