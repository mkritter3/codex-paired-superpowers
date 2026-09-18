const subcommands = {
  alpha() {
    const shorthand = true;
    process.stdout.write(JSON.stringify({ explicit: 1, shorthand, ['quoted']: 2 }));
  },
};
