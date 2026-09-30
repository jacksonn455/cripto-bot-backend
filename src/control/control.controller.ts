import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { ControlApiKeyGuard } from './control-api-key.guard';
import { ControlService } from './control.service';

class PauseDto {
  @IsOptional()
  @IsString()
  reason?: string;
}

@ApiTags('control')
@Controller('bot')
export class ControlController {
  constructor(private readonly controlService: ControlService) {}

  @Get('status')
  @ApiOperation({ summary: 'Current bot state: mode, pause state, last cycle/signals, equity, last error' })
  getStatus() {
    return this.controlService.getStatus();
  }

  @Post('pause')
  @UseGuards(ControlApiKeyGuard)
  @ApiOperation({ summary: 'Pause the bot (blocks new entries; existing positions still monitored)' })
  async pause(@Body() dto: PauseDto) {
    await this.controlService.pause(dto.reason ?? 'MANUAL');
    return this.controlService.getState();
  }

  @Post('resume')
  @UseGuards(ControlApiKeyGuard)
  @ApiOperation({ summary: 'Resume the bot' })
  async resume() {
    await this.controlService.resume();
    return this.controlService.getState();
  }

  @Post('kill-switch')
  @UseGuards(ControlApiKeyGuard)
  @ApiOperation({ summary: 'Cancel all open orders, close all open positions at market, and pause' })
  killSwitch() {
    return this.controlService.killSwitch();
  }
}
