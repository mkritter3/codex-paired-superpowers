const subcommands = {
  alpha: (args) => {
    if ('three' in args) return args.three;
    process.stdout.write(JSON.stringify({ one: args.one, two: args['two'] }));
  },
};
