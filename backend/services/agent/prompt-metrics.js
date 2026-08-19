'use strict';

// Метрики системного промпта для регрессионного аудита. Это не токенайзер
// провайдера: оценка нужна, чтобы видеть относительный рост промпта в CI и
// при локальной оптимизации, не отправляя синтетические или реальные данные в LLM.
const CHARS_PER_ESTIMATED_TOKEN = 3.5;

function countHeadings(prompt) {
  return String(prompt || '').split('\n').filter(line => {
    const text = line.trim();
    return text.endsWith(':') && /^[А-ЯЁA-Z]/.test(text);
  }).length;
}

function measurePrompt(prompt) {
  const text = String(prompt || '');
  return {
    chars: text.length,
    lines: text ? text.split('\n').length : 0,
    headings: countHeadings(text),
    // Помечено как estimate намеренно: у разных провайдеров токенизация разная.
    estimatedTokens: Math.ceil(text.length / CHARS_PER_ESTIMATED_TOKEN),
  };
}

module.exports = { CHARS_PER_ESTIMATED_TOKEN, countHeadings, measurePrompt };
