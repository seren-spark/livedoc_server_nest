/**
 * @file 图片内容分析。调用视觉模型生成图片说明，补充文档检索所需的语义信息。
 */
import { Injectable } from '@nestjs/common';
import { AppConfig } from '../config/app-config.js';

@Injectable()
export class VisionService {
  /**
   * 初始化实例依赖与本地状态。
   *
   * @param config 应用运行配置。
   */
  constructor(private readonly config: AppConfig) {}

  /**
   * 检查指定模型配置是否完整。
   *
   * @returns 条件是否满足的判断结果。
   */
  get configured(): boolean {
    return Boolean(this.config.visionApiBaseUrl && this.config.visionApiKey && this.config.visionModel);
  }

  /**
   * 调用视觉模型分析图片，返回可用于检索的文字说明。
   *
   * @param data 当前事件或操作携带的数据。
   * @param mimeType 文件内容的媒体类型。
   * @returns 整理后的状态与操作结果对象；未找到或不可用时可能为空。
   */
  async describe(data: Buffer, mimeType: string): Promise<{ description: string; error: string | null }> {
    if (!this.configured) return { description: '', error: 'Vision provider is not configured' };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.visionTimeoutSeconds * 1000);
    try {
      const response = await fetch(`${this.config.visionApiBaseUrl}/chat/completions`, {
        method: 'POST', signal: controller.signal,
        headers: { Authorization: `Bearer ${this.config.visionApiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.config.visionModel, temperature: 0.1, max_tokens: 300,
          messages: [{ role: 'user', content: [
            { type: 'text', text: '请准确描述这张文档图片中的图表、流程、对象和关键信息。不要臆测。' },
            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${data.toString('base64')}` } },
          ] }],
        }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      return { description: payload.choices?.[0]?.message?.content?.trim() ?? '', error: null };
    } catch (error) {
      return { description: '', error: `Vision description failed: ${error instanceof Error ? error.message : String(error)}` };
    } finally { clearTimeout(timeout); }
  }
}
