import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsISO8601, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class RunAgentDto {
  @ApiPropertyOptional({
    description: 'Pergunta livre (opcional). Sem ela, o agente faz a análise padrão do seu papel.',
    example: 'Os shorts estão piorando o resultado?',
    maxLength: 2000,
  })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  question?: string;

  @ApiPropertyOptional({ example: 'BTCUSDT' })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9]{2,20}$/)
  symbol?: string;

  @ApiPropertyOptional({ enum: ['BACKTEST', 'PAPER', 'LIVE'] })
  @IsOptional()
  @IsIn(['BACKTEST', 'PAPER', 'LIVE'])
  mode?: 'BACKTEST' | 'PAPER' | 'LIVE';

  @ApiPropertyOptional({ description: 'ISO date' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ description: 'ISO date' })
  @IsOptional()
  @IsISO8601()
  to?: string;
}
