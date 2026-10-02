import {
  Controller,
  Post,
  Body,
  Headers,
  UnauthorizedException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { WebhooksService } from './webhooks.service';

@ApiTags('Webhooks')
@Controller('webhooks')
export class WebhooksController {
  constructor(
    private readonly webhooksService: WebhooksService,
    private readonly config: ConfigService
  ) {}

  @Post('waha')
  async wahaWebhook(
    @Body() body: any,
    @Headers('x-webhook-secret') secret: string
  ) {
    const expectedSecret = this.config.get('WEBHOOK_SECRET');
    if (!expectedSecret)
      throw new ServiceUnavailableException('Webhook não configurado');
    if (secret !== expectedSecret) {
      throw new UnauthorizedException('Webhook secret inválido');
    }

    const event = body?.event;

    if (event === 'message') {
      await this.webhooksService.processMessage(body);
    } else if (event === 'session.status') {
      await this.webhooksService.processSessionStatus(body);
    }

    return { received: true };
  }
}
