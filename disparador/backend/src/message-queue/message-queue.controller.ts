import {
  Controller,
  Get,
  Post,
  Param,
  Headers,
  UnauthorizedException,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { MessageQueueService } from './message-queue.service';
import { MessageQueueWorker } from './message-queue.worker';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

@ApiTags('Message Queue')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('message-queue')
export class MessageQueueController {
  constructor(
    private readonly service: MessageQueueService,
    private readonly worker: MessageQueueWorker
  ) {}

  @Get('campaign/:campaignId')
  getStatus(@Param('campaignId') campaignId: string) {
    return this.service.getQueueStatus(campaignId);
  }

  @Get('campaign/:campaignId/details')
  getDetails(@Param('campaignId') campaignId: string) {
    return this.service.getQueueDetails(campaignId);
  }
}

// Endpoint separado sem guard JWT — chamado pelo Vercel Cron
@ApiTags('Message Queue')
@Controller('message-queue')
export class MessageQueueCronController {
  constructor(private readonly worker: MessageQueueWorker) {}

  @Post('process-tick')
  async processTick(@Headers('x-cron-secret') secret: string) {
    const expected = process.env.CRON_SECRET;
    if (!expected) throw new ServiceUnavailableException('Cron não configurado');
    if (secret !== expected) {
      throw new UnauthorizedException('Invalid cron secret');
    }
    return this.worker.runOnce();
  }
}
