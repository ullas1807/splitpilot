// Built-in sample receipt so anyone (e.g., judges) can try the flow without a photo.
export const SAMPLE_RECEIPT = {
  venue: 'Spice Cafe',
  items: [
    { name: 'Garlic Bread', quantity: 1, line_total: 18.0 },
    { name: 'Paneer Tikka', quantity: 1, line_total: 30.0 },
    { name: 'Masala Soda', quantity: 1, line_total: 4.0 },
    { name: 'Gulab Jamun', quantity: 1, line_total: 6.0 },
  ],
  tax: 4.64,
  tip: 5.8,
  lat: 37.7749,
  lng: -122.4194,
};
