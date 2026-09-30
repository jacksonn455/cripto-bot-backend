import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { Strategy } from './strategy.interface';
import { STRATEGIES } from './strategy.tokens';

@Injectable()
export class StrategyRegistryService {
  private readonly byName = new Map<string, Strategy>();

  constructor(@Inject(STRATEGIES) strategies: Strategy[]) {
    for (const strategy of strategies) {
      this.byName.set(strategy.name, strategy);
    }
  }

  get(name: string): Strategy {
    const strategy = this.byName.get(name);
    if (!strategy) {
      throw new NotFoundException(`Unknown strategy: ${name}`);
    }
    return strategy;
  }

  getAll(): Strategy[] {
    return [...this.byName.values()];
  }
}
