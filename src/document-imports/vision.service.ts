import { Injectable } from '@nestjs/common';
import { AppConfig } from '../config/app-config.js';

@Injectable()
export class VisionService {
  constructor(private readonly config: AppConfig) {}

  get configured(): boolean {
    return Boolean(this.config.visionApiBaseUrl && this.config.visionApiKey && this.config.visionModel);
  }

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
