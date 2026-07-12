import { registerService } from '../../core/services/registry';
import { notifyOrder } from './kitchen';

export interface FoodserviceKitchenService {
  notifyOrder: typeof notifyOrder;
}

export default function setup(): void {
  registerService('foodservice.kitchen', { notifyOrder } satisfies FoodserviceKitchenService);
}
