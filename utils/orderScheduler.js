const Order = require('../models/Order');

/**
 * Runs continuously in the background to automatically cancel pending orders
 * that the vendor has not acknowledged within the expiresAt timeframe (2 mins).
 * 
 * @param {import('socket.io').Server} io - The socket instance for emitting updates
 */
function startOrderScheduler(io) {
  // Run every 15 seconds
  setInterval(async () => {
    try {
      const now = new Date();
      // Find orders that are still pending but their expiration time has passed
      const expiredOrders = await Order.find({
        status: 'pending',
        expiresAt: { $lt: now }
      });

      if (expiredOrders.length === 0) return;

      for (const order of expiredOrders) {
        order.status = 'cancelled';
        order.cancellationReason = 'Auto-cancelled: Outlet did not respond in time';
        await order.save();

        // Emit to the customer that their order was cancelled
        io.emit('order.statusChanged', { 
          orderId: order._id, 
          status: 'cancelled',
          reason: order.cancellationReason
        });

        // Emit to the vendor dashboard to remove/update it from their screen
        io.to(`restaurant:${order.restaurantId}`).emit('order.statusChanged', { 
          orderId: order._id, 
          status: 'cancelled',
          reason: order.cancellationReason
        });
      }
      
      console.log(`[OrderScheduler] Auto-cancelled ${expiredOrders.length} expired orders.`);
    } catch (err) {
      console.error('[OrderScheduler] Error checking for expired orders:', err);
    }
  }, 15000);
}

module.exports = { startOrderScheduler };
