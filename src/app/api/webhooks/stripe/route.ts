import prisma from "@/lib/prisma";
import Stripe from "stripe";
import { stripe } from "@/lib/stripe";

const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET!; // Stripe webhook secret for verifying incoming requests

export async function POST(req: Request) {
  // Read the raw body of the request, needed for Stripe webhook verification
  const body = await req.text();

  // Get the Stripe signature from the request headers to verify the webhook
  const sig = req.headers.get("stripe-signature")!;
  let event: Stripe.Event; // Initialize the event variable to hold the parsed Stripe event

  try {
    // Verify the webhook signature and construct the Stripe event
    event = stripe.webhooks.constructEvent(body, sig, WEBHOOK_SECRET);
  } catch (err: any) {
    // Log error if verification fails and respond with a 400 error
    console.error("Webhook signature verification failed.", err.message);
    return new Response(`Webhook Error: ${err.message}`, { status: 400 });
  }

  // Log the received event for debugging
  console.log({ event });

  // Handle the event based on its type
  try {
    switch (event.type) {
      case "checkout.session.completed":
        // Retrieve the session from Stripe using the session ID from the event data
        // The "expand" option is used to include line items in the response for more detailed information
        const session = await stripe.checkout.sessions.retrieve(event.data.object.id, {
          expand: ["line_items"],
        });

        const customerId = session.customer as string; // Get the Stripe customer ID
        const customerDetails = session.customer_details; // Get customer details (e.g., email)

        if (customerDetails?.email) {
          // Find the user in the database by email
          const user = await prisma.user.findUnique({ where: { email: customerDetails.email } });
          if (!user) throw new Error("User not found"); // Error if user is not found

          // if no customer id , user is subscribe in the platform for the first time
          if (!user.customerId) {
            await prisma.user.update({
              where: { id: user.id },
              data: { customerId },
            });
          }

          // Retrieve line items (products/services bought) from the session
          const lineItems = session.line_items?.data || [];
          console.log("🚀 ~ file: route.ts:55 ~ POST ~ lineItems:", lineItems);

          // Iterate over each line item to process subscription-related updates
          for (const item of lineItems) {
            const priceId = item.price?.id; // Get price ID from Stripe price object
            const isSubscription = item.price?.type === "recurring"; // Check if it's a subscription

            // recurring: Indicates the price is for a subscription-based product, and it recurs periodically (e.g., monthly, yearly).
            // one_time: Indicates the price is for a one-time purchase, not associated with a recurring subscription.

            if (isSubscription) {
              // Calculate subscription end date based on price ID (monthly or yearly)
              let endDate = new Date();
              if (priceId === process.env.STRIPE_YEARLY_PRICE_ID!) {
                endDate.setFullYear(endDate.getFullYear() + 1); // Set to 1 year from now
              } else if (priceId === process.env.STRIPE_MONTHLY_PRICE_ID!) {
                endDate.setMonth(endDate.getMonth() + 1); // Set to 1 month from now
              } else {
                throw new Error("Invalid priceId"); // Error for unrecognized price ID
              }

              // Upsert (create or update) the user's subscription record in the database
              await prisma.subscription.upsert({
                where: { userId: user.id! },
                create: {
                  userId: user.id,
                  startDate: new Date(),
                  endDate: endDate,
                  plan: "premium",
                  period: priceId === process.env.STRIPE_YEARLY_PRICE_ID! ? "yearly" : "monthly",
                },
                update: {
                  plan: "premium",
                  period: priceId === process.env.STRIPE_YEARLY_PRICE_ID! ? "yearly" : "monthly",
                  startDate: new Date(),
                  endDate: endDate,
                },
              });

              // Update the user's plan to "premium"
              await prisma.user.update({
                where: { id: user.id },
                data: { plan: "premium" },
              });
            } else {
              // Placeholder for handling one-time purchases (if any)
            }
          }
        }
        break;
      case "customer.subscription.deleted":
        // Handle subscription cancellation event
        const subscription = await stripe.subscriptions.retrieve((event.data.object as Stripe.Subscription).id);

        // Find the user in the database using Stripe customer ID
        const user = await prisma.user.findUnique({
          where: { customerId: subscription.customer as string },
        });

        if (user) {
          // Update the user's plan to "free" if they exist in the database
          await prisma.user.update({
            where: { id: user.id },
            data: { plan: "free" },
          });
        } else {
          // Log an error if the user for the subscription cannot be found
          console.error("User not found for the subscription deleted event.");
          throw new Error("User not found for the subscription deleted event.");
        }
        break;

      // Log any unhandled events for debugging or later handling
      default:
        console.log(`Unhandled event type ${event.type}`);
    }
  } catch (error) {
    // Log any errors encountered during event handling and return a 400 response
    console.error("Error handling event", error);
    return new Response("Webhook Error", { status: 400 });
  }

  // Return a success response to acknowledge receipt of the webhook
  return new Response("Webhook received", { status: 200 });
}
