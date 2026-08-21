/** 按中文句号 / 问号 / 叹号切分，用于「至少三句」说明。 */
export function countChineseSentences(text: string): number {
  return text
    .split(/[。！？]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0).length;
}

export function hasChineseExplanation(text: string, minSentences = 3): boolean {
  return countChineseSentences(text) >= minSentences && /[\u4e00-\u9fff]/.test(text);
}
