import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, registerDecorator, ValidationOptions } from 'class-validator';
import { ReportsFilterQueryDto } from './reports-filter-query.dto';

export function isValidTimeZone(value: unknown): boolean {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** IANA time zone the runtime knows (e.g. America/Sao_Paulo); Mongo errors on unknown ones. */
function IsTimeZone(options?: ValidationOptions) {
  return (object: object, propertyName: string) =>
    registerDecorator({
      name: 'isTimeZone',
      target: object.constructor,
      propertyName,
      options: { message: `${propertyName} must be an IANA time zone, e.g. America/Sao_Paulo`, ...options },
      validator: { validate: isValidTimeZone },
    });
}

export class ByHourQueryDto extends ReportsFilterQueryDto {
  @ApiPropertyOptional({ default: 'UTC', example: 'America/Sao_Paulo', description: 'IANA time zone for the buckets' })
  @IsOptional()
  @IsString()
  @IsTimeZone()
  tz?: string;
}
